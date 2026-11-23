# analysis.R
# Runs inside webR (R compiled to WebAssembly) in the visitor's browser.
# app.js calls these functions one at a time so it can time each stage and
# drive the progress bar. State lives in the .hypnos environment.
# Nothing is written to disk or sent anywhere.

.hypnos <- new.env()

# ── Pure-R LightGBM predictor ────────────────────────────────────────────────
# The webR build of the lightgbm package cannot be loaded in the browser (it is
# compiled with threads / shared memory). mrpheus ships the YASA staging model
# as a LightGBM text dump, so it is evaluated here directly: walk each tree,
# sum leaf values per class, softmax. Mirrors LightGBM's NumericalDecision().
# Stopgap for hypnos only; mrpheus::stage_epochs() is untouched.

.hypnos_parse_tree <- function(blk) {
  get <- function(key) {
    ln <- blk[startsWith(blk, paste0(key, "="))]
    if (!length(ln)) return(NULL)
    sub(paste0("^", key, "="), "", ln[1L])
  }
  num <- function(key) {
    x <- get(key)
    if (is.null(x) || !nzchar(x)) numeric(0) else as.numeric(strsplit(x, " ", fixed = TRUE)[[1L]])
  }
  if (isTRUE(as.integer(get("num_cat")) > 0L)) {
    stop("LightGBM model has categorical splits, which this predictor does not support")
  }
  list(
    num_leaves     = as.integer(get("num_leaves")),
    split_feature  = as.integer(num("split_feature")),
    threshold      = num("threshold"),
    decision_type  = as.integer(num("decision_type")),
    left           = as.integer(num("left_child")),
    right          = as.integer(num("right_child")),
    leaf_value     = num("leaf_value")
  )
}

.hypnos_parse_model <- function(path) {
  lines   <- readLines(path, warn = FALSE)
  starts  <- which(startsWith(lines, "Tree="))
  end_at  <- which(lines == "end of trees")[1L]
  header  <- lines[seq_len(starts[1L] - 1L)]
  kv <- function(key) {
    ln <- header[startsWith(header, paste0(key, "="))][1L]
    sub(paste0("^", key, "="), "", ln)
  }
  ends  <- c(starts[-1L] - 1L, end_at - 1L)
  trees <- Map(function(s, e) .hypnos_parse_tree(lines[s:e]), starts, ends)
  list(
    num_class     = as.integer(kv("num_class")),
    feature_names = strsplit(kv("feature_names"), " ", fixed = TRUE)[[1L]],
    trees         = trees
  )
}

.hypnos_predict_tree <- function(tr, X) {
  n <- nrow(X)
  if (tr$num_leaves < 2L) return(rep(tr$leaf_value[1L], n))
  out    <- numeric(n)
  active <- seq_len(n)
  cur    <- rep(0L, n)
  while (length(active)) {
    k  <- cur + 1L
    v  <- X[cbind(active, tr$split_feature[k] + 1L)]
    dt <- tr$decision_type[k]
    if (any(bitwAnd(dt, 1L) == 1L)) stop("categorical split encountered")
    mt <- bitwShiftR(bitwAnd(dt, 12L), 2L)        # 0 none, 1 zero, 2 NaN
    dl <- bitwAnd(dt, 2L) > 0L                    # default direction is left
    v[is.na(v) & mt != 2L] <- 0
    miss <- (mt == 1L & abs(v) <= 1e-35) | (mt == 2L & is.na(v))
    left <- ifelse(miss, dl, v <= tr$threshold[k])
    nxt  <- ifelse(left, tr$left[k], tr$right[k])
    at_leaf <- nxt < 0L
    out[active[at_leaf]] <- tr$leaf_value[-nxt[at_leaf]]
    active <- active[!at_leaf]
    cur    <- nxt[!at_leaf]
  }
  out
}

.hypnos_predict_matrix <- function(model, X) {
  K   <- model$num_class
  raw <- matrix(0, nrow(X), K)
  for (t in seq_along(model$trees)) {
    k <- ((t - 1L) %% K) + 1L
    raw[, k] <- raw[, k] + .hypnos_predict_tree(model$trees[[t]], X)
  }
  raw <- raw - apply(raw, 1L, max)
  e   <- exp(raw)
  e / rowSums(e)
}

# ── Pipeline stages (called one at a time from app.js) ───────────────────────

hypnos_header <- function(path) {
  hdr <- edfReader::readEdfHeader(path)
  .hypnos$hdr <- hdr
  paste0(nrow(hdr$sHeaders), " signals, ", hdr$nrOfRecords, " records x ",
         toString(hdr$recordedPeriod), " s")
}

hypnos_read <- function(path, channels = NULL) {
  rec <- mrpheus::read_edf(path, channels = channels)
  .hypnos$rec <- rec
  paste0(paste0(rec$channels$label, " @ ", rec$channels$sample_rate, " Hz", collapse = ", "),
         " | duration_s=", toString(rec$duration_s))
}

hypnos_segment <- function(epoch_s = 30) {
  .hypnos$psg <- mrpheus::prepare_psg(.hypnos$rec, epoch_s = epoch_s)
  paste0(.hypnos$psg$n_epochs, " epochs")
}

hypnos_preprocess <- function() {
  .hypnos$psg <- mrpheus::preprocess_psg(.hypnos$psg)
  "ok"
}

# Same channel choice as mrpheus::stage_epochs() (first non-bad of each type)
hypnos_features <- function() {
  psg  <- .hypnos$psg
  cm   <- psg$channel_map
  pick <- function(type) cm$label[cm$type == type & !cm$bad][1L]
  eeg <- pick("EEG"); eog <- pick("EOG"); emg <- pick("EMG")
  .hypnos$features <- mrpheus:::.extract_staging_features(psg, eeg, eog, emg)
  paste0("EEG=", eeg, ", EOG=", eog, ", EMG=", emg, ", ",
         nrow(.hypnos$features), " epochs x ", ncol(.hypnos$features) - 1L, " features")
}

hypnos_predict <- function() {
  path <- system.file("models", "yasa_staging.txt", package = "mrpheus")
  if (!nzchar(path) && file.exists("/tmp/yasa_staging.txt")) path <- "/tmp/yasa_staging.txt"
  if (!nzchar(path)) {
    root <- system.file(package = "mrpheus")
    stop("YASA staging model not found. mrpheus ", as.character(utils::packageVersion("mrpheus")),
         " installs: ", paste(list.dirs(root, full.names = FALSE, recursive = FALSE), collapse = ", "),
         "; models/ holds: [", paste(list.files(file.path(root, "models")), collapse = ", "), "]")
  }
  model <- .hypnos_parse_model(path)

  feats   <- .hypnos$features
  missing <- setdiff(model$feature_names, names(feats))
  if (length(missing)) stop("Missing model features: ", paste(missing, collapse = ", "))
  X <- as.matrix(feats[, model$feature_names])

  probs  <- .hypnos_predict_matrix(model, X)
  labels <- c("N1", "N2", "N3", "REM", "W")      # alphabetical, as in stage_epochs()
  colnames(probs) <- paste0("prob_", labels)
  stage <- labels[apply(probs, 1L, which.max)]

  .hypnos$stages <- tibble::as_tibble(cbind(
    data.frame(epoch = feats$epoch, stage = stage), probs
  ))
  paste0(length(model$trees), " trees; ",
         paste0(names(table(stage)), "=", as.integer(table(stage)), collapse = ", "))
}

hypnos_spectrogram <- function() {
  tryCatch({
    cm  <- .hypnos$psg$channel_map
    eeg <- cm$label[cm$type == "EEG" & !cm$bad][1L]
    sp  <- mrpheus::compute_spectrogram(.hypnos$psg, channel = eeg, freq_range = c(0, 30))
    .hypnos$spec <- list(channel = eeg, freqs = sp$freqs, power = round(sp$power, 1))
    paste0(eeg, ", ", nrow(sp$power), " epochs x ", length(sp$freqs), " bins")
  }, error = function(e) {
    .hypnos$spec <- NULL
    paste0("skipped: ", conditionMessage(e))
  })
}

hypnos_metrics <- function(epoch_s = 30) {
  rec    <- .hypnos$rec
  psg    <- .hypnos$psg
  stages <- .hypnos$stages

  hyp  <- mrpheus::export_hypnogram(stages, epoch_s = epoch_s)
  arch <- hypnoR::compute_sleep_architecture(hyp)

  stage_chr <- as.character(stages$stage)
  stage_min <- vapply(
    c("W", "N1", "N2", "N3", "REM"),
    function(s) sum(stage_chr == s, na.rm = TRUE) * epoch_s / 60,
    numeric(1)
  )

  out <- list(
    recording = list(
      duration_h = psg$n_epochs * epoch_s / 3600,
      n_epochs   = psg$n_epochs,
      epoch_s    = epoch_s,
      channels   = psg$channel_map
    ),
    metrics   = as.list(arch),
    stage_min = as.list(stage_min),
    stages    = stage_chr
  )
  out$spectrogram <- .hypnos$spec     # NULL (omitted) if the spectrogram stage was skipped

  as.character(jsonlite::toJSON(out, auto_unbox = TRUE, na = "null", digits = 4))
}
