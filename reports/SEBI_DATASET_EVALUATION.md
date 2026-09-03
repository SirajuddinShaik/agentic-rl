# SEBI Question Dataset Evaluation

**Archive:** `/Users/shaik.s/Downloads/SEBI-Question-Dataset.zip`  
**Evaluation date:** 2026-08-15  
**Goal:** select grounded, difficult data for the Xyne/Polar agentic GRPO pipeline.

**Run decision:** the next experiment uses the repaired 484-row Pranav metadata
graph dataset directly. It has been normalized to Miles JSONL as
`data/sebi_pranav_metadata_graph_train.jsonl`.

## Main Metric: Documents and Embeddings per Question

Here, **embedding count** means the number of gold `chunk_ids`. Each chunk maps
to one 1,024-dimensional BF16 `chunk_embedding` in Vespa. Raw embedding vectors
are not stored in the dataset. Runtime query embeddings are separate: the
embedder creates one query vector for each semantic-search tool call.

| Dataset | Documents/question | Gold chunk embeddings/question | P90 embeddings | Maximum | Multi-doc questions |
|---|---:|---:|---:|---:|---:|
| Current 2,858-row training set | 1.00 | 1.72 | 3 | 6 | 0% |
| **Pranav metadata graph repaired** | **2.34** | **5.38** | **9** | **16** | **100%** |
| Root `master_data(1).xlsx` | 1.25 | 4.92 | 8 | 16 | 20.22% |
| Root `master_data.xlsx` | 1.15 | 4.49 | 8 | 16 | 12.27% |
| Enforcement master | 1.00 | 4.61 | 5 | 9 | ~0% |
| Root clean `master_data.csv` | 1.02 | 3.77 | 5 | 16 | 1.36% |
| Root single-doc JSONL | 1.00 | 3.65 | 5 | 5 | 0% |

**Winner on the requested metric:** `Pranav Questions - Metadata Graph
repaired.csv`. Relative to the current dataset, each question requires **2.34x
as many documents** and **3.13x as many gold chunk embeddings**. It is the best
data for forcing multiple searches and cross-document synthesis, but it has only
484 questions.

The recommended weighted hard mixture below presents approximately **1.29
documents and 4.56 gold chunk embeddings per sampled question**, with about 22%
multi-document prompts.

## Executive Decision

### Best broad file

Use **`master_data.csv`** at the archive root as the canonical broad dataset.

- 35,561 rows; 35,560 unique questions
- 9,748 unique documents and 123,412 unique chunks
- No malformed list fields and no chunk-to-document mismatches
- Contains all 24,861 `single_doc_s` rows, all 6,216 `full_coverage` rows,
  all 4,000 `single_doc_h` rows, and the repaired 484-row metadata-graph set
- Supersedes `chunk_questions_formatted.jsonl` and
  `Formatted_Merged_All_Ground_truth.json`; both are fully contained in it

### Best dataset for our agentic RL run

Do not train on the complete broad master uniformly. Build **SEBI-Agentic-Hard-v1**:

| Source | Filter | Rows | Why |
|---|---|---:|---|
| `master_data.csv` | `single_doc_h` | 4,000 | Broad hard retrieval, concise answers, 3,228 docs |
| `Pranav Questions - Metadata Graph repaired.csv` | all | 484 | Best multi-document reasoning set; 2.34 docs/question |
| `Enforcement-Orders/master_data.csv` | all | 6,306 | Clean legal/enforcement reasoning; latest focused coverage |
| `Enforcement-Orders/sebi_order_sub2.csv` | all | 200 | Strong manually inspected court/RTI-style questions |
| **Combined** | exact-question deduplicated | **10,990** | 4,230 docs; 25,491 chunks; no exact question overlap |

Use the 894 `verified_full_coverage` rows in `final_master_data.csv` as one fixed
evaluation slice. They cover 31 documents. Excluding every training row that
touches those documents removes 25 rows and leaves **10,965 training rows**.

The hard pool contains only 485 native multi-document questions. Assign the
metadata-graph rows a sampler weight of **6x** rather than physically duplicating
them. This makes roughly 22% of sampled prompts multi-document while preserving
clean epoch accounting.

## Dataset Ranking

Scores are relative to this archive and emphasize metadata correctness,
grounding, difficulty, document diversity, and immediate training readiness.

| Rank | Dataset | Rating | Decision |
|---:|---|---:|---|
| 1 | `Pranav ... Metadata Graph repaired.csv` | 9.3/10 | Best documents/embeddings per question; too small alone |
| 2 | Root `master_data.csv` | 9.1/10 | Canonical broad source and best large file |
| 3 | `Enforcement-Orders/master_data.csv` | 8.9/10 | Best focused hard/domain expansion |
| 4 | `Enforcement-Orders/sebi_order_sub2.csv` | 8.8/10 | High-quality judged legal set; only 200 rows |
| 5 | `Formatted_Merged_All_Ground_truth.json` | 8.5/10 | Clean but already contained in root master |
| 6 | Root `chunk_questions_formatted.jsonl` | 8.2/10 | Excellent scale/coverage; mostly easier single-doc QA |
| 7 | Root `master_data.xlsx` | 6.3/10 | Contains a low-quality 5,500-row LLM pipeline and duplicates |
| 8 | `final_master_data.csv` | 5.8/10 raw | Useful new subsets, but requires serialization repair |

## Key Measurements

| Dataset | Rows | Unique docs | Unique chunks | Multi-doc | Metadata defects |
|---|---:|---:|---:|---:|---:|
| Root `master_data.csv` | 35,561 | 9,748 | 123,412 | 1.36% | 0 |
| Root `master_data.xlsx` | 36,678 | 9,464 | 129,870 | 12.27% | 320 duplicate rows |
| Root `final_master_data.csv` | 36,993 | 9,726 | 127,123 | 1.29% | 1,325 malformed rows |
| Root single-doc JSONL | 24,861 | 8,604 | 88,067 | 0% | 1 duplicate row |
| Repaired metadata graph | 484 | 291 | 1,538 | 100% | 0 |
| Enforcement master | 6,306 | 940 | 9,132 | ~0% | 0 |

## Quality Findings

### Strong pipelines

**`single_doc_h`**

- 4,000 rows across 3,228 documents
- Answers average 79 words, making reward comparison cleaner than the more
  verbose single-document pipeline
- Questions require targeted legal, numerical, or regulatory retrieval

**Repaired metadata knowledge graph**

- 484 rows; every question is multi-document
- 2.34 documents and 5.38 chunks per question on average
- Questions are concise (24 words average) and answers are concise (73 words)
- Best match for learning multi-search synthesis and cross-document comparison

**Enforcement master**

- 6,306 unique questions; clean document/chunk linkage
- 4.61 chunks per question and 136-word average answers
- Good domain depth across prosecutions, court orders, RTI appeals, recovery,
  and enforcement procedure

### Usable but not primary

**`single_doc_s`** provides the broadest coverage: 24,861 rows over 8,604
documents. It is valuable for curriculum warm-up or diversity sampling, but it
is easier and more verbose (158 answer words average). Do not let it dominate
the first hard GRPO run.

**`full_coverage`** has 6,216 questions over only 539 documents. It covers each
selected document densely and is useful for evaluation or targeted curriculum,
but uniform training risks learning document-specific patterns.

### Exclude or repair

**The 5,500-row `LLM based pipeline` in `master_data.xlsx` should be excluded.**

- 41.82% of answers contain generation boilerplate such as “Conclusion: Taken
  together...”
- 37.36% of answers exceed 300 words
- Sampled answers often concatenate numbered source fragments instead of
  producing a direct ground-truth answer
- Its 70.95% multi-document rate looks attractive, but the supervision quality
  is not reliable enough for GRPO rewards

**Do not use `final_master_data.csv` directly.** It contains 1,325 rows where
both `docIds` and `chunk_ids` are double-serialized. That creates 2,650 malformed
fields for a normal one-pass loader. The underlying IDs often look recoverable,
but they must be decoded and validated before using its new subsets.

**Do not concatenate format duplicates.** The enforcement CSV and XLSX contain
the same 6,306 questions. The repaired metadata CSV and XLSX contain the same
484 questions. Choose the CSV copies.

## Training and Evaluation Rules

1. Split by **document ID**, never randomly by question. Otherwise questions
   from the same source document leak across train and evaluation.
2. Keep all documents referenced by a multi-document question in the same split.
3. Deduplicate normalized questions before sampling.
4. Validate that every `chunk_id` prefix belongs to one of the row's `docIds`.
5. Preserve `pipeline`, `docIds`, and `chunk_ids` in Polar metadata for
   citation/retrieval reward components.
6. Track reward separately for single-document, multi-document, enforcement,
   and long-answer groups; one aggregate mean will hide regressions.
7. Use the broad `single_doc_s` pool only after the hard mixture has completed a
   fixed-eval comparison against the base model.

## Final Recommendation

For the next production experiment, use **SEBI-Agentic-Hard-v1** with 10,965
document-disjoint training rows, metadata-graph sampling weight 6x, and a fixed
evaluation containing the 894 verified rows plus a second document-disjoint
sample from `single_doc_h` and enforcement data.

If only one existing file may be selected without preprocessing, select root
**`master_data.csv`**, then filter by its `pipeline` column at load time.
