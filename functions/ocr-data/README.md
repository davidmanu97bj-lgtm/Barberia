Spanish OCR data for the weekly Uber screenshot reader. Loaded locally by Tesseract.js; no third-party OCR API or runtime model download.

Source: https://github.com/naptha/tessdata/blob/gh-pages/4.0.0_best_int/spa.traineddata.gz
Upstream Tesseract language models: https://github.com/tesseract-ocr/tessdata_best (Apache-2.0).

The scanner verifies readable weekly date ranges and the principal earnings amount. It does not authenticate screenshots or prove income. Administrative approval remains required. Unreadable, wrong-period and inconsistent screenshots fail closed and never create a liquidation. Screenshots without a year cannot establish the year independently; this limitation is inherent in the source screen.
