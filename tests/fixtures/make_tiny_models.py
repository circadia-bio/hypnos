"""Regenerate the tiny LightGBM fixtures used by tests/r/test-predictor.R.

Needs: pip install lightgbm numpy.  The fixtures are committed, so the R tests do not need Python.
Each model is trained on a few hundred random rows, then LightGBM itself predicts a test matrix
(random rows, missing values, exact zeros, and rows sitting exactly on split thresholds). The R
predictor in analysis.R must reproduce those probabilities.

The YASA models only use one split type (decision_type 2). These tiny models use the others, so
the predictor is checked on missing-value handling the YASA models never exercise:
  tiny_nan   decision_type 8 and 10  (missing values follow the learnt direction)
  tiny_zero  decision_type 4 and 6   (zero counts as missing)
  tiny_cat   a categorical split      (the predictor must refuse it, not guess)
"""
import re
import numpy as np
import lightgbm as lgb

N_CLASS, N_FEAT, ROUNDS = 5, 5, 1
rng = np.random.default_rng(20261124)
names = [f"f{i}" for i in range(N_FEAT)]


def make_data(n, with_nan=False, with_zero=False):
    X = rng.normal(size=(n, N_FEAT))
    y = (np.floor(2.5 * X[:, 0] + 1.5 * X[:, 1] - X[:, 2] + rng.normal(scale=0.7, size=n)).astype(int)) % N_CLASS
    if with_nan:
        X[rng.random(X.shape) < 0.15] = np.nan
    if with_zero:
        X[rng.random(X.shape) < 0.15] = 0.0
    return X, y


def thresholds(path):
    txt = open(path).read()
    vals = []
    for m in re.finditer(r"^threshold=(.*)$", txt, re.M):
        vals += [float(v) for v in m.group(1).split()]
    return sorted(set(vals))


def test_matrix(path, n_random=20):
    X = rng.normal(size=(n_random, N_FEAT))
    X[rng.random(X.shape) < 0.12] = np.nan
    X[rng.random(X.shape) < 0.12] = 0.0
    rows = [X]
    th = thresholds(path)
    edge = []
    for t in th[:: max(1, len(th) // 12)]:            # a dozen thresholds, spread across the model
        for j in range(N_FEAT):
            r = rng.normal(size=N_FEAT)
            r[j] = t                                   # exactly on the threshold: goes left (<=)
            edge.append(r.copy())
            r[j] = np.nextafter(t, np.inf)             # the next representable value: goes right
            edge.append(r.copy())
    rows.append(np.array(edge[:14]))
    rows.append(np.array([[np.nan] * N_FEAT, [0.0] * N_FEAT]))
    return np.vstack(rows)


def write(tag, params, X, y, cat=None):
    ds = lgb.Dataset(X, y, feature_name=names, categorical_feature=cat or "auto", free_raw_data=False)
    p = dict(objective="multiclass", num_class=N_CLASS, num_leaves=4, min_data_in_leaf=8, learning_rate=0.3,
             verbose=-1, seed=1, deterministic=True, force_row_wise=True, num_threads=1)
    p.update(params)
    bst = lgb.train(p, ds, num_boost_round=ROUNDS)
    path = f"tiny_{tag}.txt"
    bst.save_model(path)
    if cat:
        n_cat = sorted(set(int(m) for m in re.findall(r"^num_cat=(\d+)", open(path).read(), re.M)))
        print(path, "num_cat values per tree:", n_cat)
        return
    Xt = test_matrix(path)
    P = bst.predict(Xt)
    with open(f"tiny_{tag}_X.csv", "w") as f:
        f.write(",".join(names) + "\n")
        for r in Xt:
            f.write(",".join("NA" if np.isnan(v) else repr(float(v)) for v in r) + "\n")
    np.savetxt(f"tiny_{tag}_P.csv", P, delimiter=",", fmt="%.17g")
    types = sorted(set(int(v) for m in re.findall(r"^decision_type=(.*)$", open(path).read(), re.M) for v in m.split()))
    print(f"{path}: {bst.num_trees()} trees, {Xt.shape[0]} test rows, decision_type values {types}")


X, y = make_data(400, with_nan=True)
write("nan", {}, X, y)                                   # missing values go the learnt way (NaN)
X, y = make_data(400, with_zero=True)
write("zero", {"zero_as_missing": True}, X, y)           # zero counts as missing
X = rng.normal(size=(500, N_FEAT))
X[:, 4] = rng.integers(0, 10, 500)                       # a categorical feature, 10 categories
y = (X[:, 4].astype(int) * 3 + (X[:, 0] > 0)) % N_CLASS  # it decides the class
write("cat", {"min_data_per_group": 3, "cat_smooth": 1, "cat_l2": 1, "max_cat_to_onehot": 2, "min_data_in_leaf": 5}, X, y, cat=[4])
