#!/usr/bin/env node
'use strict'
require('../src/index.js').run(process.argv.slice(2)).then((code) => process.exit(code))
