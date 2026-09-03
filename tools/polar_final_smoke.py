import copy, json, time
from pathlib import Path
import httpx, yaml
cfg_path = Path("/root/miles/tmp/xyne_fsdp/20260812_071805/polar_config_custom.yaml")
cfg = yaml.safe_load(cfg_path.read_text())
t = copy.deepcopy(cfg["polar_task_template"])
vals = {k: v for k, v in cfg.items() if k.startswith("polar_")}
def expand(x):
    if isinstance(x, dict): return {k: expand(v) for k,v in x.items()}
    if isinstance(x, list): return [expand(v) for v in x]
    if isinstance(x, str):
        for k,v in vals.items(): x = x.replace("{args."+k+"}", str(v))
        return x
    return x

data = json.loads(Path("/data/siraj/xyne_s/xyne_qa_train.jsonl").read_text().splitlines()[0])
t = expand(t)
t["task_id"] = "polar-xyne-final-smoke-1786541833"
t["instruction"] = data["prompt"]
t["num_samples"] = 1
t["timeout_seconds"] = 600
t["metadata"] = {"smoke": True}
t["evaluator"]["config"]["expected_doc_ids"] = (data.get("metadata") or {}).get("doc_ids", [])
t["runtime"]["import_path"] = "polar.runtime.local:LocalRuntime"
t["runtime"]["backend"] = "docker"
# The live ProRL gateway owns the local runtime; image is intentionally unused.
with httpx.Client(base_url="http://127.0.0.1:8080", timeout=httpx.Timeout(None, connect=30)) as c:
    r = c.post("/rollout/task/submit", json=t); r.raise_for_status(); task=r.json()["task_id"]
    print("submitted", task)
    for _ in range(180):
        time.sleep(2)
        out = c.get("/rollout/task/"+task).json()
        if out.get("status") in ("completed", "failed"):
            print(json.dumps({"task_id":out.get("task_id"),"status":out.get("status"),"sessions":[{"status":s.get("status"),"error":s.get("error"),"trace_count":len((s.get("trajectory") or {}).get("traces") or []),"evaluation":((s.get("trajectory") or {}).get("metadata") or {}).get("evaluation")} for s in out.get("results",[])]}, indent=2))
            break
    else: print("poll_timeout")
