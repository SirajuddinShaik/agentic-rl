# XYNE Polar Runtime

Build the base runtime image from a ProRL checkout after placing these files at
its `xyne/` path:

```bash
docker build -f xyne/Dockerfile -t polar-xyne-runtime:withwait .
```

`topology.sgl.yaml` is the historical localhost smoke stub. It is not the
active multinode topology. Use `configs/polar/rtx1-rtx2.remote.yaml` for the
current 8-actor plus 4-rollout deployment.
