"""Strict OHLCV ingestion and immutable, content-addressed dataset versions."""
import hashlib
import io
import json
import re
import sqlite3
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'data'
TZ = timezone(timedelta(hours=8))


@contextmanager
def connect():
    STORE.mkdir(exist_ok=True)
    db = sqlite3.connect(STORE / 'research.sqlite', timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, symbol TEXT, source TEXT, retrieved_at TEXT, payload TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT, dataset_id TEXT, payload TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS raw_sources (id TEXT PRIMARY KEY, url TEXT, retrieved_at TEXT, payload TEXT)')
    try:
        yield db
        db.commit()
    finally:
        db.close()


def validate_symbol(symbol):
    if not re.fullmatch(r'(?:\d{4,6}|\d{4,5}[A-Z])(?:\.TW|\.TWO)?', symbol):
        raise ValueError('僅接受台股／ETF 代號（如 2330、00985A），可附 .TW / .TWO')
    return symbol


def validate(rows, now=None, split_events=None):
    df = pd.DataFrame(rows).rename(columns={'d': 'date', 'o': 'open', 'h': 'high', 'l': 'low', 'c': 'close', 'v': 'volume'})
    cols = ['date', 'open', 'high', 'low', 'close', 'volume']
    if not set(cols).issubset(df):
        raise ValueError('研究需要 date,open,high,low,close,volume；不接受收盤價補造 OHLCV')
    df = df[cols].copy()
    df['date'] = pd.to_datetime(df.date, format='%Y-%m-%d', errors='raise')
    if df.date.duplicated().any():
        raise ValueError('日期重複，請先核對來源')
    df = df.sort_values('date').reset_index(drop=True)
    for c in cols[1:]:
        df[c] = pd.to_numeric(df[c], errors='raise')
    a = df[cols[1:]].to_numpy(dtype=float)
    if not np.isfinite(a).all() or (a[:, :4] <= 0).any() or (a[:, 4] < 0).any():
        raise ValueError('價格需為有限正數；成交量不得為負或空值')
    if ((df.high < df[['open', 'close', 'low']].max(axis=1)) | (df.low > df[['open', 'close', 'high']].min(axis=1))).any():
        raise ValueError('OHLC 高低價關係不合理')
    now = now or datetime.now(TZ)
    cutoff = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
    if (df.date.dt.date > cutoff).any():
        raise ValueError('含未來或今日尚未完成的日 K；請於台北時間 16:00 後更新')
    if (df.date.dt.day_of_week >= 5).any():
        raise ValueError('日 K 含週末；請提供交易日資料')
    # Fail closed on probable split/unit errors instead of learning a spurious crash.
    jumps=df.close.pct_change().abs()>.35
    for i in df.index[jumps]:
        matches=[e for e in (split_events or []) if e['date']==str(df.date.iloc[i].date()) and e.get('type')=='split']
        if not matches or abs(float(df.close.iloc[i]/df.close.iloc[i-1])/matches[0]['factor']-1)>.15:
            raise ValueError('單日跳動超過 35%，且無可核對的拆股資料；停止分析')
    if len(df) < 650:
        raise ValueError('至少需要 650 筆完整交易日 OHLCV（建議 5 年）')
    return df


def records(df):
    out = df.copy()
    out['date'] = out.date.dt.strftime('%Y-%m-%d')
    return out.to_dict('records')


def save_dataset(symbol, source, df, metadata=None):
    symbol = validate_symbol(symbol)
    rows = records(df)
    payload = json.dumps({'symbol': symbol, 'source': source, 'bars': rows,
        'metadata':metadata or {'split_events':df.attrs.get('split_events',[])}}, sort_keys=True, allow_nan=False)
    digest = hashlib.sha256(payload.encode()).hexdigest()
    with connect() as db:
        db.execute('INSERT OR IGNORE INTO datasets VALUES (?,?,?,?,?)', (digest, symbol, source, datetime.now(TZ).isoformat(), payload))
    return digest


def load_dataset(digest):
    with connect() as db:
        row = db.execute('SELECT payload,retrieved_at FROM datasets WHERE id=?', (digest,)).fetchone()
    if not row:
        raise ValueError('找不到資料版本')
    result = json.loads(row[0])
    result['retrievedAt'] = row[1]
    return result


def request_json(url):
    last = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(attempt + 1)
    raise ValueError(f'來源連線失敗：{last}')


def fetch_yahoo(symbol):
    """Explicitly unofficial. No synthetic fallback and no partial daily candles."""
    validate_symbol(symbol)
    errors = []
    for ticker in ([symbol] if '.' in symbol else [symbol + '.TW', symbol + '.TWO']):
        try:
            raw = request_json(f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=5y&interval=1d')
            result = raw['chart']['result'][0]
            q = result['indicators']['quote'][0]
            now = datetime.now(TZ)
            cutoff = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
            rows = []
            for i, stamp in enumerate(result['timestamp']):
                day = datetime.fromtimestamp(stamp, TZ).date()
                if day > cutoff:
                    continue
                rows.append({'date': str(day), **{c: q[c][i] for c in ['open', 'high', 'low', 'close', 'volume']}})
            df = validate(rows)
            return df, f'Yahoo Finance unofficial {ticker}; raw OHLCV, price return only'
        except Exception as exc:
            errors.append(f'{ticker}: {exc}')
    raise ValueError('；'.join(errors))


def ingest_csv(text):
    return validate(pd.read_csv(io.StringIO(text)).to_dict('records'))


def parse_twse(raw):
    if raw.get('stat') != 'OK':
        raise ValueError('TWSE 無完整行情：'+str(raw.get('stat')))
    rows = []
    for r in raw.get('data', []):
        year, month, day = map(int, r[0].split('/'))
        if any(str(v).strip() in ['--','---',''] for v in r[3:7]):
            raise ValueError(f'{year+1911:04d}-{month:02d}-{day:02d} 無完整成交價，可能停牌或無成交；不補造 OHLC，暫停此股票分析')
        def number(i):
            return float(r[i].replace(',', ''))
        rows.append({'date': f'{year+1911:04d}-{month:02d}-{day:02d}', 'open': number(3),
            'high': number(4), 'low': number(5), 'close': number(6), 'volume': number(1)})
    return rows


def fetch_twse(symbol):
    """TWSE listed stocks, 49 monthly requests; cached with original responses.

    No cross-provider fallback: OTC users must select another source explicitly.
    """
    validate_symbol(symbol)
    if symbol.endswith('.TWO'):
        raise ValueError('TWSE 僅上市股票；上櫃請選 CSV 或 Yahoo .TWO')
    ticker = symbol.removesuffix('.TW')
    now = datetime.now(TZ)
    cutoff = now.date() if now.hour >= 16 else now.date()-timedelta(days=1)
    latest = now.year*12+now.month-1
    rows = []
    for total in range(latest-48, latest+1):
        y, m = total//12, total%12+1
        url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={y:04d}{m:02d}01&stockNo={ticker}'
        with connect() as db:
            cached = db.execute('SELECT payload,retrieved_at FROM raw_sources WHERE url=? ORDER BY retrieved_at DESC LIMIT 1', (url,)).fetchone()
        ttl = 6*3600 if total == latest else 7*86400
        if cached and total == latest:
            cached_at = datetime.fromisoformat(cached[1])
            if cached_at.date() != now.date() or (cached_at.hour < 16 <= now.hour):
                ttl = 0
        if cached and (now-datetime.fromisoformat(cached[1])).total_seconds() < ttl:
            raw = json.loads(cached[0])
        else:
            raw = request_json(url)
            encoded = json.dumps(raw, sort_keys=True, ensure_ascii=True)
            digest = hashlib.sha256((url+encoded).encode()).hexdigest()
            with connect() as db:
                db.execute('INSERT OR REPLACE INTO raw_sources VALUES (?,?,?,?)', (digest, url, now.isoformat(), encoded))
            time.sleep(.35)
        # A current month with no sessions yet is valid, but historical holes are not.
        if raw.get('stat') != 'OK' and total == latest and now.day <= 7:
            continue
        rows.extend(parse_twse(raw))
    rows = [r for r in rows if r['date'] <= str(cutoff)]
    try:
        df=validate(rows)
    except ValueError as exc:
        if '35%' not in str(exc):raise
        from .context import finmind
        from fractions import Fraction
        splits=[]
        for r in finmind('TaiwanStockSplitPrice',ticker,rows[0]['date'],rows[-1]['date']):
            ratio=float(Fraction(float(r['before_price'])/float(r['after_price'])).limit_denominator(100))
            splits.append({'date':r['date'],'type':'split','factor':1/ratio,'shareRatio':ratio})
        df=validate(rows,split_events=splits);df.attrs['split_events']=splits
    return df, f'TWSE official STOCK_DAY {ticker}; raw OHLCV; volume shares; price return only'


def demo():
    """Deterministic test fixture, never passed off as market data."""
    r = np.random.default_rng(42)
    c = 100 * np.exp(np.cumsum(r.normal(.0003, .014, 1000)))
    o = np.r_[c[0], c[:-1]] * np.exp(r.normal(0, .004, len(c)))
    return validate(pd.DataFrame({'date': pd.bdate_range(end='2026-10-30', periods=len(c)).strftime('%Y-%m-%d'), 'open': o,
        'high': np.maximum(o, c) * (1 + r.uniform(.001, .02, len(c))), 'low': np.minimum(o, c) * (1 - r.uniform(.001, .02, len(c))),
        'close': c, 'volume': r.integers(1000000, 10000000, len(c))}).to_dict('records'))
