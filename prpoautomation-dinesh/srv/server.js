const cds = require("@sap/cds");
const express = require("express");
const path = require("path");

cds.on("bootstrap", app => {

    app.use(
        "/",
        express.static(
            path.join(__dirname, "../app/prpoautomation-ui/dist")
        )
    );

});

module.exports = cds.server;