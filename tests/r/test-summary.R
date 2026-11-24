# The sleep summary: time in bed counts every epoch of the window, unscored epochs (no valid EEG,
# NA) are in bed but in no stage, and wake after sleep onset runs to the end of the window.

summ <- function(stage, epoch_s = 30) hy$.hypnos_sleep_summary(stage, epoch_s)

# 16 epochs of 30 s: sleep onset at the first epoch, two unscored epochs in the middle
hand <- c("N1", "N2", "N2", "N3", NA, NA, "N2", "REM", "REM", "W", "N2", "W", "W", "REM", "N2", "W")

test_that("a hand-computed window gives the expected markers", {
  s <- summ(hand)
  expect_equal(s$tib_min, 8)                  # 16 epochs, the unscored ones included
  expect_equal(s$tst_min, 5)                  # 10 sleep epochs
  expect_equal(s$se_pct, 5 / 8 * 100)
  expect_equal(s$sol_min, 0)                  # asleep from the first epoch
  expect_equal(s$waso_min, 2)                 # wake epochs 10, 12, 13, 16 after onset
  expect_equal(s$rem_lat_min, 3.5)            # first REM is the 8th epoch: 7 * 0.5
  expect_equal(s$sws_lat_min, 1.5)            # first N3 is the 4th epoch: 3 * 0.5
  expect_equal(s$pct_n1, 10)                  # percentages are of sleep time, not of time in bed
  expect_equal(s$pct_n2, 50)
  expect_equal(s$pct_n3, 10)
  expect_equal(s$pct_rem, 30)
  expect_equal(s$no_signal_epochs, 2)
})

test_that("unscored epochs before sleep onset count as time before onset", {
  s <- summ(c("W", NA, NA, "N2", "N2", "W"))
  expect_equal(s$sol_min, 1.5)                # three epochs before the first sleep epoch
  expect_equal(s$tib_min, 3)
  expect_equal(s$waso_min, 0.5)               # the final wake counts: WASO runs to the end of the window
})

test_that("wake at the end of the window is wake after sleep onset", {
  expect_equal(summ(c("N2", "W", "W", "W"))$waso_min, 1.5)
  expect_equal(summ(c("N2", "N2", "N2", "N2"))$waso_min, 0)
})

test_that("a window with no sleep has no onset, latencies or WASO, and zero efficiency", {
  s <- summ(c("W", "W", NA, "W"))
  expect_equal(s$tst_min, 0)
  expect_equal(s$se_pct, 0)
  expect_true(is.na(s$sol_min))
  expect_true(is.na(s$waso_min))
  expect_true(is.na(s$rem_lat_min))
  expect_true(is.na(s$pct_n2))
  expect_equal(s$no_signal_epochs, 1)
})

test_that("a window with nothing staged is all time in bed and no sleep", {
  s <- summ(rep(NA_character_, 6))
  expect_equal(s$tib_min, 3)
  expect_equal(s$tst_min, 0)
  expect_equal(s$no_signal_epochs, 6)
})

test_that("latencies are NA when the stage never occurs", {
  s <- summ(c("W", "N1", "N2", "N2"))
  expect_true(is.na(s$rem_lat_min))
  expect_true(is.na(s$sws_lat_min))
  expect_equal(s$pct_rem, 0)
})

test_that("epoch length scales every time, not the percentages", {
  a <- summ(hand, 30); b <- summ(hand, 60)
  for (k in c("tib_min", "tst_min", "sol_min", "waso_min", "rem_lat_min", "sws_lat_min")) expect_equal(b[[k]], 2 * a[[k]])
  for (k in c("se_pct", "pct_n1", "pct_n2", "pct_n3", "pct_rem")) expect_equal(b[[k]], a[[k]])
})

# ── Things that must hold for any hypnogram ───────────────────────────────

test_that("the markers are consistent with each other on random windows", {
  set.seed(2026)
  lv <- c("W", "N1", "N2", "N3", "REM")
  for (r in 1:300) {
    n  <- sample(10:500, 1)
    st <- sample(lv, n, replace = TRUE, prob = c(0.45, 0.05, 0.3, 0.1, 0.1))
    if (r %% 2 == 0) st[sample(n, sample(0:(n %/% 2), 1))] <- NA
    s  <- summ(st)

    wake     <- sum(st == "W", na.rm = TRUE) * 0.5
    unscored <- sum(is.na(st)) * 0.5
    expect_equal(s$tst_min + wake + unscored, s$tib_min)            # every minute is in exactly one place
    expect_equal(s$no_signal_epochs, sum(is.na(st)))
    expect_equal(s$se_pct, 100 * s$tst_min / s$tib_min)
    expect_true(s$se_pct >= 0 && s$se_pct <= 100)

    if (s$tst_min > 0) {
      expect_equal(s$pct_n1 + s$pct_n2 + s$pct_n3 + s$pct_rem, 100)   # percentages of sleep time sum to 100
      onset <- which(!is.na(st) & st != "W")[1]
      # WASO is the wake from onset on; the wake before onset is sleep onset latency (less unscored time)
      wake_before_onset <- sum(st[seq_len(onset - 1)] == "W", na.rm = TRUE) * 0.5
      expect_equal(s$waso_min, wake - wake_before_onset)
      expect_equal(s$sol_min, (onset - 1) * 0.5)
      expect_true(s$sol_min >= 0 && s$waso_min >= 0)
      expect_true(s$sol_min + s$tst_min <= s$tib_min)
      for (lat in c(s$rem_lat_min, s$sws_lat_min)) expect_true(is.na(lat) || (lat >= 0 && lat <= s$tib_min))
    } else {
      expect_true(is.na(s$sol_min) && is.na(s$waso_min))
    }
  }
})

test_that("shifting the whole night by an unscored lead-in changes only time in bed and onset latency", {
  base    <- summ(hand)
  shifted <- summ(c(NA, NA, NA, NA, hand))
  expect_equal(shifted$tib_min, base$tib_min + 2)
  expect_equal(shifted$sol_min, base$sol_min + 2)
  expect_equal(shifted$tst_min, base$tst_min)
  expect_equal(shifted$waso_min, base$waso_min)
  expect_equal(shifted$rem_lat_min, base$rem_lat_min)             # latencies from onset do not move
})

# ── Which engine produces them ────────────────────────────────────────────

fields <- c("tst_min", "tib_min", "se_pct", "sol_min", "waso_min", "rem_lat_min", "sws_lat_min",
            "pct_n1", "pct_n2", "pct_n3", "pct_rem", "no_signal_epochs")
same <- function(a, b) (is.na(a) && is.na(b)) || isTRUE(all.equal(as.numeric(a), as.numeric(b), tolerance = 1e-12))
agree <- function(x, y) all(vapply(fields, function(f) same(x[[f]], y[[f]]), logical(1)))

test_that("without hypnoR the built-in summary is used, and says so", {
  r <- without_hypnor(hy$.hypnos_summary(hand))
  expect_match(r$engine, "built-in")
  expect_match(r$engine, "not installed")
  expect_true(agree(r$metrics, summ(hand)))
})

test_that("an older hypnoR without waso_until is not used", {
  skip_if(hypnor_can_do_it(), "the installed hypnoR is new enough")
  skip_if_not_installed("hypnoR")
  r <- hy$.hypnos_summary(hand)
  expect_match(r$engine, "older")
  expect_true(agree(r$metrics, summ(hand)))
})

test_that("hypnoR and the built-in summary agree on random windows, with and without unscored epochs", {
  skip_if_not(hypnor_can_do_it(), "hypnoR with waso_until is not installed")
  set.seed(9)
  lv <- c("W", "N1", "N2", "N3", "REM")
  for (r in 1:200) {
    n  <- sample(10:400, 1)
    st <- sample(lv, n, replace = TRUE, prob = c(0.45, 0.05, 0.3, 0.1, 0.1))
    if (r %% 2 == 0) st[sample(n, sample(0:(n %/% 2), 1))] <- NA
    if (r %% 40 == 0) st[] <- "W"
    if (r %% 55 == 0) st[] <- NA_character_
    expect_true(agree(hy$.hypnos_summary(st)$metrics, summ(st)), info = paste("draw", r))
  }
  expect_match(hy$.hypnos_summary(hand)$engine, "^hypnoR ")
})
