# Print every signal of an EDF as one line, "label,value,value,...", read with edfReader.
# Used by the JavaScript tests to check that the reduced EDF the page builds is read by R
# as the same numbers that were in the original file.

args <- commandArgs(trailingOnly = TRUE)
suppressMessages(library(edfReader))

hdr  <- readEdfHeader(args[1])
sigs <- readEdfSignals(hdr, signals = "All")
if (!is.null(sigs$signal)) sigs <- stats::setNames(list(sigs), hdr$sHeaders$label)   # one signal comes back bare

for (lab in names(sigs)) {
  cat(lab, ",", paste(format(sigs[[lab]]$signal, digits = 15, trim = TRUE), collapse = ","), "\n", sep = "")
}
