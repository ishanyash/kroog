---
name: dbt-cost-check
description: Estimate what a dbt run will cost before it runs, and stop runs over the limit.
---

# dbt cost check

1. Run `dbt run-operation estimate_cost --args '{model: <name>}'` for the model.
2. Compare the estimate with `vars.cost_gate` in `dbt_project.yml`: over `stop`, refuse; over `warn`, say so.
3. Full refreshes of the orders models are the usual cause of a high estimate; suggest an incremental model first.
