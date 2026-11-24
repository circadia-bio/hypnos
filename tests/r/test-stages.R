# The pipeline stages that analysis.R runs one at a time in the browser, exercised on fake state
# (no mrpheus needed): signal validity and the window, staging with a model, and the final markers.

skip_if_not_installed("tibble")
skip_if_not_installed("jsonlite")

fake_psg <- function(sig, sr = 10, epoch_s = 30, eeg = "C4:A1") {
  list(
    n_epochs    = floor(length(sig) / (sr * epoch_s)),
    epoch_s     = epoch_s,
    edf         = list(signals = stats::setNames(list(list(signal = sig)), eeg)),
    channel_map = tibble::tibble(label = eeg, type = "EEG", sample_rate = sr, bad = FALSE)
  )
}

fresh_state <- function() { hy$hypnos_reset(); hy$.hypnos }

# ── hypnos_validity() ─────────────────────────────────────────────────────

test_that("validity finds where the signal is lost and sets the window and the no-signal epochs", {
  st <- fresh_state()
  set.seed(1)
  spe <- 300                                        # 10 Hz * 30 s
  sig <- c(stats::runif(150 * spe, -50, 50), rep(3, 130 * spe))   # 150 good epochs, then 130 flat
  st$psg <- fake_psg(sig)
  st$channels <- list(eeg = "C4:A1", eog = NA_character_, emg = NA_character_)

  msg <- hy$hypnos_validity()

  expect_equal(sum(st$state == "flat"), 130)
  expect_equal(which(st$no_signal)[1], 151)
  expect_equal(unname(st$window), c(1, 150))
  expect_match(msg, "130 flat")
  expect_match(msg, "window epochs 1 to 150")
  expect_match(msg, "\\(1.25 h\\)")                 # 150 epochs of 30 s
})

test_that("a short loss of signal does not end the window", {
  st <- fresh_state()
  set.seed(2)
  spe <- 300
  sig <- c(stats::runif(100 * spe, -50, 50), rep(0, 60 * spe), stats::runif(40 * spe, -50, 50))
  st$psg <- fake_psg(sig)
  st$channels <- list(eeg = "C4:A1", eog = NA_character_, emg = NA_character_)
  hy$hypnos_validity()
  expect_equal(unname(st$window), c(1, 200))        # 60 flat epochs: half an hour, not an hour
  expect_equal(sum(st$no_signal), 60)
})

test_that("a channel that is flat throughout stops the run and says what to do", {
  st <- fresh_state()
  st$psg <- fake_psg(rep(0, 40 * 300))
  st$channels <- list(eeg = "C4:A1", eog = NA_character_, emg = NA_character_)
  expect_error(hy$hypnos_validity(), "Choose another EEG channel in Analysis settings")
})

test_that("validity reads the channel that was chosen, not the first one", {
  st <- fresh_state()
  set.seed(3)
  spe <- 300
  good <- stats::runif(20 * spe, -50, 50)
  psg  <- fake_psg(good, eeg = "C3:A2")
  psg$edf$signals[["C4:A1"]] <- list(signal = rep(0, 20 * spe))      # the other EEG channel is flat
  psg$channel_map <- tibble::tibble(label = c("C3:A2", "C4:A1"), type = "EEG", sample_rate = 10, bad = FALSE)
  st$psg <- psg
  st$channels <- list(eeg = "C3:A2", eog = NA_character_, emg = NA_character_)
  hy$hypnos_validity()
  expect_equal(sum(st$no_signal), 0)
})

# ── hypnos_predict() ──────────────────────────────────────────────────────

test_that("stages are LightGBM's most probable class, labelled alphabetically, and not given to epochs without signal", {
  st <- fresh_state()
  X  <- as.matrix(utils::read.csv(fixture("tiny_nan_X.csv"), na.strings = "NA"))
  P  <- unname(as.matrix(utils::read.csv(fixture("tiny_nan_P.csv"), header = FALSE)))
  n  <- nrow(X)

  st$features  <- tibble::as_tibble(cbind(epoch = seq_len(n), as.data.frame(X)))
  st$channels  <- list(eeg = "C4:A1", eog = NA_character_, emg = NA_character_)     # the EEG-only classifier
  st$no_signal <- seq_len(n) %in% 5:9

  msg <- with_model(fixture("tiny_nan.txt"), hy$hypnos_predict())

  classes  <- c("N1", "N2", "N3", "REM", "W")             # the order of the model's classes
  expected <- classes[max.col(P, "first")]
  expected[5:9] <- NA
  expect_identical(st$stages$stage, expected)
  expect_equal(st$stages$epoch, seq_len(n))
  expect_equal(unname(as.matrix(st$stages[, paste0("prob_", classes)])), P, tolerance = 1e-12)
  expect_match(msg, "classifier eeg,")
  expect_match(msg, "not staged=5")
})

test_that("the classifier follows the channels: a missing model for EOG and EMG is reported by name", {
  st <- fresh_state()
  st$features <- tibble::tibble(epoch = 1:3, f0 = 0, f1 = 0, f2 = 0, f3 = 0, f4 = 0)
  st$channels <- list(eeg = "C4:A1", eog = "EOG1", emg = "EMG")
  seen <- NULL
  old <- hy$.hypnos_find_model
  hy$.hypnos_find_model <- function(key) { seen <<- key; fixture("tiny_nan.txt") }
  on.exit(hy$.hypnos_find_model <- old)
  st$no_signal <- rep(FALSE, 3)
  hy$hypnos_predict()
  expect_equal(seen, "eeg_eog_emg")
})

test_that("features the model needs but that were not computed are reported, not silently zero-filled", {
  st <- fresh_state()
  st$features <- tibble::tibble(epoch = 1:3, f0 = 0, f1 = 0)             # f2, f3, f4 missing
  st$channels <- list(eeg = "C4:A1", eog = NA_character_, emg = NA_character_)
  st$no_signal <- rep(FALSE, 3)
  expect_error(with_model(fixture("tiny_nan.txt"), hy$hypnos_predict()), "Missing model features: f2, f3, f4")
})

# ── hypnos_metrics() ──────────────────────────────────────────────────────

metrics_state <- function() {
  st <- fresh_state()
  stage <- c("W", "W", "N1", "N2", "N2", "N3", NA, NA, "N2", "REM", "REM", "W", "N2", "W", "W", "REM", "N2", "W", "W", "W")
  st$psg     <- list(n_epochs = 20L, channel_map = tibble::tibble(label = "C4:A1", type = "EEG", sample_rate = 10, bad = FALSE))
  st$stages  <- tibble::tibble(epoch = 1:20, stage = stage)
  st$state   <- ifelse(is.na(stage), "flat", "ok")
  st$window  <- c(first = 3L, last = 18L)
  st$spec    <- NULL
  invisible(st)
}
metrics_json <- function(...) jsonlite::fromJSON(hy$hypnos_metrics(...), simplifyVector = FALSE)

test_that("the markers are computed over the automatic window, with the numbers worked out by hand", {
  metrics_state()
  j <- metrics_json()
  expect_equal(j$window$first, 3); expect_equal(j$window$last, 18)
  expect_equal(j$window$auto_first, 3); expect_equal(j$window$auto_last, 18)
  expect_false(j$window$manual)

  m <- j$metrics                                    # epochs 3 to 18: 16 epochs, 10 asleep, 2 unscored
  expect_equal(m$tib_min, 8); expect_equal(m$tst_min, 5); expect_equal(m$se_pct, 62.5)
  expect_equal(m$sol_min, 0); expect_equal(m$waso_min, 2)
  expect_equal(m$rem_lat_min, 3.5); expect_equal(m$sws_lat_min, 1.5)
  expect_equal(c(m$pct_n1, m$pct_n2, m$pct_n3, m$pct_rem), c(10, 50, 10, 30))
})

test_that("minutes in each stage plus minutes without signal add up to the window", {
  metrics_state()
  j <- metrics_json()
  window_min <- (j$window$last - j$window$first + 1) * j$recording$epoch_s / 60
  stage_min  <- sum(unlist(j$stage_min))
  expect_equal(stage_min + j$no_signal_min, window_min)
  expect_equal(j$no_signal_min, 1)
  expect_equal(j$stage_min$W, 2); expect_equal(j$stage_min$N2, 2.5); expect_equal(j$stage_min$REM, 1.5)
})

test_that("the whole recording is reported, not only the window, and epochs without signal have no stage", {
  metrics_state()
  j <- metrics_json()
  expect_length(j$stages, 20)
  expect_length(j$signal, 20)
  expect_equal(j$recording$n_epochs, 20)
  expect_equal(j$recording$duration_h, 20 * 30 / 3600, tolerance = 1e-3)    # the JSON keeps four digits
  expect_null(j$stages[[7]]); expect_null(j$stages[[8]])         # unstaged: null in the JSON
  expect_equal(j$stages[[3]], "N1")
  expect_equal(unlist(j$signal)[7:8], c("flat", "flat"))
})

test_that("a window chosen by the user replaces the automatic one, and says so", {
  metrics_state()
  j <- metrics_json(first = 1L, last = 6L)                      # W W N1 N2 N2 N3
  expect_true(j$window$manual)
  expect_equal(c(j$window$first, j$window$last), c(1, 6))
  expect_equal(c(j$window$auto_first, j$window$auto_last), c(3, 18))   # the automatic window is still reported
  expect_equal(j$metrics$tib_min, 3); expect_equal(j$metrics$tst_min, 2)
  expect_equal(j$metrics$sol_min, 1); expect_equal(j$metrics$waso_min, 0)
})

test_that("a window that runs past the recording is cut to it", {
  metrics_state()
  j <- metrics_json(first = 0L, last = 99L)
  expect_equal(c(j$window$first, j$window$last), c(1, 20))
  expect_equal(j$metrics$tib_min, 10)
})

test_that("an empty window is an error, not a row of NAs", {
  metrics_state()
  expect_error(hy$hypnos_metrics(first = 10L, last = 5L), "window is empty")
})

test_that("the summary says which engine produced it", {
  metrics_state()
  expect_match(metrics_json()$summary_engine, "^(hypnoR|built-in)")
  metrics_state()
  expect_match(without_hypnor(metrics_json())$summary_engine, "built-in")
})

test_that("results do not depend on the engine", {
  skip_if_not(hypnor_can_do_it(), "hypnoR with waso_until is not installed")
  metrics_state(); a <- metrics_json()$metrics
  metrics_state(); b <- without_hypnor(metrics_json())$metrics
  expect_equal(a[names(b)], b)
})

test_that("a window is recomputed from the stored stages, without the large objects", {
  st <- metrics_state()
  st$rec <- "big"; st$features <- "big"; st$psg$edf <- "big"; st$psg$epochs <- "big"
  hy$hypnos_trim()
  expect_null(st$rec); expect_null(st$features); expect_null(st$psg$edf); expect_null(st$psg$epochs)
  expect_equal(metrics_json(first = 1L, last = 6L)$metrics$tst_min, 2)    # still works
})

test_that("reset empties the state", {
  st <- metrics_state()
  expect_true(length(ls(st)) > 0)
  hy$hypnos_reset()
  expect_length(ls(st, all.names = TRUE), 0)
})
