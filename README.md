# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/utan001/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/utan001/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver: for each instance under /input/<id>/ it writes /output/<id>/solution.txt with the player's moves in LURD. It partitions the level into rooms the generator's way (cut the dead squares of the hallway row), then solves each room push-optimally with an A* over pushes (assignment heuristic over single-box push distances, dead-square and frozen-block pruning), the other rooms' boxes standing as walls. Practice set: a perfect 1,000,000 (every instance solved in exactly P* pushes) in about 0.25 s for the set; the house baseline plain-astar scores 200,000 on the same set.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with i001..i005> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
