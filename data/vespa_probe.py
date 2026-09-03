#!/usr/bin/env python3
import json, sys, urllib.request
from urllib.parse import quote

BASE="http://127.0.0.1:18080"
NS="kb_items"
def present(doc_id):
    url=f"{BASE}/document/v1/namespace/{NS}/docid/{quote(doc_id,safe='')}?fieldSet={NS}%3Achunk_embeddings"
    try:
        req=urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status==200
    except urllib.error.HTTPError as e:
        return e.code==200
    except Exception:
        return None  # network/parse error -> unknown

def main(path):
    ids=[l.strip() for l in open(path) if l.strip()]
    found=0; missing=0; unknown=0; bad=0
    for i,doc in enumerate(ids):
        st=present(doc)
        if st is True: found+=1
        elif st is False: missing+=1
        else: unknown+=1
        if (i+1)%50==0:
            print(f"  ...{i+1}/{len(ids)} found={found} missing={missing} unknown={unknown}", flush=True)
    print(f"RESULT {path}: total={len(ids)} found={found} missing={missing} unknown={unknown}")

if __name__=="__main__":
    main(sys.argv[1])
