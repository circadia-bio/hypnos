# Is an epoch of the EEG usable? flat = more than half of the samples are one value;
# clipped = more than 0.1% of them sit on the channel's highest or lowest value.

epoch_state_reference <- function(sig, spe, n, flat_share = 0.5, rail_share = 0.001) {
  # A plain, slow, per-epoch statement of the definition
  hi <- max(sig); lo <- min(sig)
  vapply(seq_len(n), function(i) {
    x <- sig[((i - 1) * spe + 1):(i * spe)]
    if (max(tabulate(match(x, unique(x)))) / spe > flat_share) "flat"
    else if (mean(x == hi | x == lo) > rail_share) "clipped"
    else "ok"
  }, character(1))
}

spe <- 1000L
ep  <- function(i) ((i - 1L) * spe + 1L):(i * spe)

# 12 epochs of continuous noise in (-60, 60); the channel's extremes (+-100) are placed by hand
make_signal <- function(seed = 1) {
  set.seed(seed)
  sig <- stats::runif(12 * spe, -60, 60)
  sig[1] <- 100                 # the highest value of the channel, once, in epoch 1
  sig[spe + 1] <- -100          # the lowest value, once, in epoch 2
  sig
}

test_that("a clean noisy epoch is ok", {
  state <- hy$.hypnos_epoch_state(make_signal(), spe, 12)
  expect_equal(state[5], "ok")
  expect_equal(state[1], "ok")     # a single extreme sample is not enough to call it clipped
  expect_equal(state[2], "ok")
})

test_that("an epoch of one repeated value is flat, whatever the value", {
  sig <- make_signal()
  sig[ep(3)] <- 0
  sig[ep(4)] <- 37.25
  sig[ep(5)] <- -100.0001
  state <- hy$.hypnos_epoch_state(sig, spe, 12)
  expect_equal(state[3:5], rep("flat", 3))
})

test_that("flat means strictly more than half of the samples", {
  sig <- make_signal()
  sig[ep(3)][1:500] <- 7                 # exactly 50%: not flat
  sig[ep(4)][1:501] <- 7                 # 50% and one sample: flat
  state <- hy$.hypnos_epoch_state(sig, spe, 12)
  expect_equal(state[3], "ok")
  expect_equal(state[4], "flat")
})

test_that("clipped means more than 0.1% of the samples on the channel's extremes", {
  sig <- make_signal()
  sig[ep(6)][c(10, 20)] <- 100           # 2 of 1000 samples at the maximum: clipped
  sig[ep(7)][c(10, 20)] <- c(100, -100)  # the maximum and the minimum count together
  sig[ep(8)][10] <- 100                  # 1 of 1000: exactly 0.1%, not more
  state <- hy$.hypnos_epoch_state(sig, spe, 12)
  expect_equal(state[6:8], c("clipped", "clipped", "ok"))
})

test_that("an epoch that is both flat and at an extreme is flat", {
  sig <- make_signal()
  sig[ep(9)] <- 100
  expect_equal(hy$.hypnos_epoch_state(sig, spe, 12)[9], "flat")
})

test_that("the fast implementation equals the plain definition on constructed signals", {
  sig <- make_signal()
  sig[ep(3)] <- 0
  sig[ep(4)][1:501] <- 7
  sig[ep(6)][c(10, 20)] <- 100
  expect_identical(hy$.hypnos_epoch_state(sig, spe, 12), epoch_state_reference(sig, spe, 12))
})

test_that("the fast implementation equals the plain definition on random signals, including ties", {
  set.seed(11)
  for (r in 1:25) {
    n   <- sample(5:20, 1)
    sig <- stats::runif(n * spe, -50, 50)
    for (i in sample(n, sample(0:n, 1))) {              # some flat epochs, some partly flat
      keep <- sample(c(0.3, 0.5, 0.5001, 0.8, 1), 1)
      sig[ep(i)][seq_len(round(keep * spe))] <- sample(c(0, 12.5, -3), 1)
    }
    sig[sample(length(sig), sample(1:30, 1))] <- max(sig)  # ties at the maximum
    expect_identical(hy$.hypnos_epoch_state(sig, spe, n), epoch_state_reference(sig, spe, n))
  }
})

test_that("samples beyond the last whole epoch are ignored", {
  sig <- c(make_signal(), stats::runif(437))
  expect_identical(hy$.hypnos_epoch_state(sig, spe, 12), hy$.hypnos_epoch_state(sig[1:(12 * spe)], spe, 12))
})
