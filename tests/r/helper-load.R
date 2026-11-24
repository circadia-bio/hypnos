# Load analysis.R into one environment shared by the tests, as the page loads it into webR.
# Nothing here needs mrpheus: the pieces that call it are tested through the state they leave behind.

hy <- new.env(parent = globalenv())
sys.source(testthat::test_path("..", "..", "analysis.R"), envir = hy)

fixture <- function(...) testthat::test_path("..", "fixtures", ...)

# Replace which model file hypnos_predict() reads, for the duration of `expr`
with_model <- function(path, expr) {
  old <- hy$.hypnos_find_model
  hy$.hypnos_find_model <- function(key) path
  on.exit(hy$.hypnos_find_model <- old)
  force(expr)
}

# Run `expr` with hypnoR hidden from requireNamespace(), as if it were not installed
without_hypnor <- function(expr) {
  hy$requireNamespace <- function(package, ..., quietly = FALSE) {
    if (identical(package, "hypnoR")) FALSE else base::requireNamespace(package, ..., quietly = quietly)
  }
  on.exit(rm("requireNamespace", envir = hy))
  force(expr)
}

hypnor_can_do_it <- function() {
  requireNamespace("hypnoR", quietly = TRUE) &&
    "waso_until" %in% names(formals(hypnoR::compute_sleep_architecture))
}
