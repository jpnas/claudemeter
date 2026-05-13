#!/bin/sh
set -e
npm install --omit=dev
node server.js
