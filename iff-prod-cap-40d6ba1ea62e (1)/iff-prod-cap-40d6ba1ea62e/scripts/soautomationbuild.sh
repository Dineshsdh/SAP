#!/usr/bin/env bash

echo "**Starting Postgres build**"

echo "- creating dir gen/pg/db -"
mkdir -p gen/pg/db

echo "- compiling model -"
cds compile '*' > gen/pg/db/csn.json

echo "- copy .csv files -"
cp -r db/data gen/pg/db/data

echo "- creating package.json -"
echo '{
  "dependencies": {
    "@sap/cds": "^9",
    "@cap-js/postgres": "2.0.6"
  },
  "scripts": {
    "start": "cds-deploy"
  }
}' > gen/pg/package.json
