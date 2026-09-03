# Data

This directory contains dataset tooling only. The private SEBI training JSONL
files are intentionally not committed.

Available tools:

- `build_sebi_combined_dataset.py` — builds the combined SEBI dataset.
- `vespa_probe.py` — probes the live Vespa index and profiles.

Expected training JSONL fields:

```json
{
  "prompt": "user question",
  "label": "reference answer",
  "metadata": {
    "instance_id": "case-001",
    "doc_ids": ["clf-example"],
    "chunk_ids": ["clf-example#44"]
  }
}
```

Store the real dataset outside Git and pass its absolute path to the launch
script.
