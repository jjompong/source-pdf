# @pagasa-parser/source-pdf
[![npm version](https://img.shields.io/npm/v/@pagasa-parser/source-pdf.svg?style=flat-square)](https://www.npmjs.org/package/@pagasa-parser/source-pdf)
[![npm downloads](https://img.shields.io/npm/dm/@pagasa-parser/source-pdf.svg?style=flat-square)](http://npm-stat.com/charts.html?package=@pagasa-parser/source-pdf)

This plugin for [pagasa-parser](https://github.com/pagasa-parser/pagasa-parser) allows for parsing of PAGASA Tropical Cyclone Bulletins (TCBs). It only supports Tropical Cyclone Bulletin-type PDFs and **not** Severe Weather Bulletin-type PDFs, which were phased out in early 2021. Support for these types of bulletins are planned for the future.

This package requires Java to be available in the PATH, as it relies on [tabula-java](https://github.com/tabulapdf/tabula-java). This package does not depend on Log4j.

This Maybagyoba-maintained fork tracks the original
[`pagasa-parser/source-pdf`](https://github.com/pagasa-parser/source-pdf)
project. Each Tabula mode has a bounded runtime controlled by
`PAGASA_PARSER_TABULA_TIMEOUT_MS` (default: 45000), and emits a structured
`pagasa_parser.tabula` log with its mode, status, and duration.

The parser accepts PAGASA coordinate layouts with or without degree symbols on
either coordinate (for example, both `14.5°N, 134.6°E` and
`14.5°N, 134.6E`). Missing required bulletin fields produce explicit parse
errors so callers can distinguish unsupported PDF layouts from transport
failures.
