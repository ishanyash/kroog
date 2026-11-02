# dbt-cost

- The weekly dbt spend is about $40; the orders models are 60% of it.
- Cost limits live in `dbt_project.yml` under `vars.cost_gate`: warn at $2, stop at $5.
- `tests/test_cost_gate.py` covers the gate; run it with `pytest tests/test_cost_gate.py`.
