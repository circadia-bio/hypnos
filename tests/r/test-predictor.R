# The LightGBM predictor. The browser cannot load the lightgbm package (it is built with threads),
# so analysis.R walks the trees itself. It has to give what LightGBM gives. The fixtures are tiny
# models trained with the real LightGBM, with LightGBM's own probabilities for a test matrix that
# includes missing values, exact zeros and values sitting exactly on split thresholds. They use
# split types the YASA models do not, so missing-value handling is tested too.
# Regenerate with tests/fixtures/make_tiny_models.py.

read_matrix <- function(path) as.matrix(utils::read.csv(path, na.strings = "NA"))
read_probs  <- function(path) unname(as.matrix(utils::read.csv(path, header = FALSE)))

expect_matches_lightgbm <- function(tag) {
  model <- hy$.hypnos_parse_model(fixture(sprintf("tiny_%s.txt", tag)))
  X     <- read_matrix(fixture(sprintf("tiny_%s_X.csv", tag)))
  P     <- read_probs(fixture(sprintf("tiny_%s_P.csv", tag)))
  R     <- hy$.hypnos_predict_matrix(model, X)

  expect_identical(colnames(X), model$feature_names)
  expect_equal(dim(R), dim(P))
  expect_lt(max(abs(R - P)), 1e-12)
  expect_identical(max.col(R, "first"), max.col(P, "first"))
}

test_that("it reproduces LightGBM where missing values follow the learnt direction (NaN split type)", {
  expect_matches_lightgbm("nan")
})

test_that("it reproduces LightGBM where zero counts as missing (zero split type)", {
  expect_matches_lightgbm("zero")
})

test_that("the fixtures really do use the split types they are meant to test", {
  types <- function(tag) {
    txt <- readLines(fixture(sprintf("tiny_%s.txt", tag)))
    sort(unique(as.integer(unlist(strsplit(sub("^decision_type=", "", grep("^decision_type=", txt, value = TRUE)), " ")))))
  }
  expect_true(all(types("nan") %in% c(8, 10)))     # missing type NaN, default left or right
  expect_true(all(types("zero") %in% c(4, 6)))     # missing type zero
  expect_false(2 %in% c(types("nan"), types("zero")))   # not the type the YASA models use
})

test_that("a model with categorical splits is refused rather than guessed at", {
  expect_error(hy$.hypnos_parse_model(fixture("tiny_cat.txt")), "categorical")
})

test_that("a gzip-compressed model gives the same predictions as the plain text one", {
  gz <- tempfile(fileext = ".txt.gz")
  con <- gzfile(gz, "wt"); writeLines(readLines(fixture("tiny_nan.txt")), con); close(con)
  X <- read_matrix(fixture("tiny_nan_X.csv"))
  plain <- hy$.hypnos_predict_matrix(hy$.hypnos_parse_model(fixture("tiny_nan.txt")), X)
  zipped <- hy$.hypnos_predict_matrix(hy$.hypnos_parse_model(gz), X)
  expect_identical(zipped, plain)
})

test_that("probabilities are proper: non-negative, summing to one per row", {
  model <- hy$.hypnos_parse_model(fixture("tiny_nan.txt"))
  R <- hy$.hypnos_predict_matrix(model, read_matrix(fixture("tiny_nan_X.csv")))
  expect_true(all(R >= 0 & R <= 1))
  expect_equal(rowSums(R), rep(1, nrow(R)))
})

test_that("a model with one leaf per tree predicts a constant", {
  tr <- list(num_leaves = 1L, leaf_value = 0.25)
  expect_equal(hy$.hypnos_predict_tree(tr, matrix(0, 4, 2)), rep(0.25, 4))
})

# ── Rounding to single precision, as YASA does ────────────────────────────

test_that("float32 rounding matches IEEE single precision", {
  f32 <- hy$.hypnos_as_float32
  expect_identical(f32(0.1), 0.10000000149011612)
  expect_identical(f32(1 / 3), 0.3333333432674408)
  expect_identical(f32(16777217), 16777216)           # 2^24 + 1 is not representable
  expect_identical(f32(c(1, -2.5, 0)), c(1, -2.5, 0)) # values that are exact stay exact
  expect_identical(f32(1e-50), 0)                     # underflows to zero in single precision
  expect_identical(f32(1e50), Inf)                    # and overflows to infinity
})

test_that("float32 rounding keeps missing values and the matrix shape", {
  x <- matrix(c(0.1, NA, 3, NaN), 2, 2)
  r <- x; r[] <- hy$.hypnos_as_float32(x)
  expect_equal(dim(r), c(2, 2))
  expect_true(is.na(r[2, 1]) && is.na(r[2, 2]))
  expect_identical(r[1, 1], 0.10000000149011612)
})

test_that("rounding is idempotent", {
  x <- stats::rnorm(50)
  expect_identical(hy$.hypnos_as_float32(hy$.hypnos_as_float32(x)), hy$.hypnos_as_float32(x))
})

# ── Which classifier, which channel names ─────────────────────────────────

test_that("the classifier is chosen from the channels present", {
  key <- hy$.hypnos_model_key
  expect_equal(key(FALSE, FALSE), "eeg")
  expect_equal(key(TRUE, FALSE), "eeg_eog")
  expect_equal(key(FALSE, TRUE), "eeg_emg")
  expect_equal(key(TRUE, TRUE), "eeg_eog_emg")
})

test_that("exact channel patterns match the label and nothing else", {
  labels <- c("C4:A1", "EEG Fpz-Cz", "EOG(L)", "EMG+chin", "A.B", "SpO2", "ECG 2", "x[1]", "a\\b", "p|q", "C4*")
  for (l in labels) {
    pat <- hy$.hypnos_exact(l)
    expect_true(grepl(pat, l), info = l)
    expect_false(grepl(pat, paste0(l, " ")), info = l)     # nothing after it
    expect_false(grepl(pat, paste0("X", l)), info = l)     # nothing before it
  }
  expect_false(grepl(hy$.hypnos_exact("A.B"), "AxB"))      # a dot is a dot
  expect_false(grepl(hy$.hypnos_exact("C4*"), "C4444"))    # a star is a star
})

test_that("no channel at all is a pattern that matches no label", {
  pat <- hy$.hypnos_exact(NA_character_)
  expect_false(any(grepl(pat, c("EEG", "C4", "SpO2", "O2", "EMG", " "))))
})

test_that("SpO2 is not mistaken for an EEG channel when the EEG is named exactly", {
  expect_false(grepl(hy$.hypnos_exact("C4:A1"), "SpO2"))
  expect_true(grepl("O2", "SpO2"))        # the default pattern's mistake that exact patterns avoid
})
