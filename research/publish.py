"""Publish a small, explicitly dated official quote feed, without any local account data."""
import json
from datetime import datetime
from pathlib import Path
from .data import TZ, fetch_twse


if __name__ == '__main__':
    df, source = fetch_twse('2330')
    quote = {'symbol': '2330', 'source': source, 'asOf': str(df.date.iloc[-1].date()),
        'publishedAt': datetime.now(TZ).isoformat(), 'kind': 'official-eod',
        'bars': [{'d': str(r.date.date()), 'o': float(r.open), 'h': float(r.high), 'l': float(r.low),
                  'c': float(r.close), 'v': float(r.volume)} for r in df.tail(180).itertuples()]}
    target = Path(__file__).resolve().parents[1]/'public-quotes'
    target.mkdir(exist_ok=True)
    (target/'2330.json').write_text(json.dumps(quote, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    print(f'Published official 2330 close as of {quote["asOf"]}; {len(quote["bars"])} bars')
