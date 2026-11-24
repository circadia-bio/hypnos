# The analysis window runs from the first epoch with a signal to the epoch before the first stretch of
# at least 60 minutes (120 epochs) with none. Stretches before the first signal do not count.

win <- function(no_signal) {
  w <- hy$.hypnos_auto_window(no_signal)
  if (is.null(w)) NULL else c(w[["first"]], w[["last"]])
}
ok   <- function(n) rep(FALSE, n)     # epochs with a signal
lost <- function(n) rep(TRUE, n)      # epochs with none

test_that("with a signal throughout, the window is the whole recording", {
  expect_equal(win(ok(300)), c(1, 300))
})

test_that("a signal lost for an hour or more ends the window", {
  expect_equal(win(c(ok(100), lost(120), ok(50))), c(1, 100))     # exactly 120 epochs: ends it
  expect_equal(win(c(ok(100), lost(121), ok(50))), c(1, 100))
  expect_equal(win(c(ok(100), lost(500))), c(1, 100))             # lost to the end
})

test_that("a shorter loss stays inside the window", {
  expect_equal(win(c(ok(100), lost(119), ok(50))), c(1, 269))     # 119 epochs: one short of an hour
  expect_equal(win(c(ok(100), lost(30), ok(50), lost(60))), c(1, 240))   # and a short loss at the end too
})

test_that("a signal that returns after a long loss is not part of the window", {
  expect_equal(win(c(ok(60), lost(200), ok(400))), c(1, 60))      # the notebook's rule: the first long loss ends it
})

test_that("the window starts at the first epoch with a signal, however long the lead-in", {
  expect_equal(win(c(lost(5), ok(200))), c(6, 205))
  expect_equal(win(c(lost(150), ok(40), lost(130))), c(151, 190))
  expect_equal(win(c(lost(300), ok(10))), c(301, 310))
})

test_that("no epoch with a signal means no window", {
  expect_null(win(lost(50)))
  expect_null(win(logical(0)))
})

test_that("the window is always a run of whole epochs inside the recording", {
  set.seed(5)
  for (r in 1:200) {
    runs <- sample(c(TRUE, FALSE), 10, replace = TRUE)
    lens <- sample(c(1, 5, 60, 119, 120, 200), 10, replace = TRUE)
    ns   <- rep(runs, lens)
    w    <- win(ns)
    if (all(ns)) { expect_null(w); next }
    expect_true(w[1] >= 1 && w[2] <= length(ns) && w[1] <= w[2])
    expect_false(ns[w[1]])                                       # it starts on an epoch with a signal
    expect_false(any(rle(ns[w[1]:w[2]])$lengths[rle(ns[w[1]:w[2]])$values] >= 120))   # and holds no long loss
  }
})
