sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast"
], function (
    Controller,
    JSONModel,
    Filter,
    FilterOperator,
    MessageToast
) {
    "use strict";

    return Controller.extend(
        "prpoautomation.controller.POStatus",
        {

            
            /* INIT */
           

            onInit: function () {

                var oModel = new JSONModel({

                    POs: [],

                    totalPOs: 0,

                    outputSuccess: 0,

                    outputFailed: 0,

                    openGRN: 0,

                    completedGRN: 0

                });

                this.getView().setModel(
                    oModel,
                    "poStatus"
                );

                this._loadPOStatus();

            },

            


/* LOAD PO STATUS */


_loadPOStatus: async function () {

    try {

        const response = await fetch(
            "/odata/v4/prpo/getPOStatus",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: "{}"
            }
        );

        const data = await response.json();

        console.log("================================");
        console.log("PO STATUS RESPONSE");
        console.log(JSON.stringify(data, null, 2));
        console.log("================================");

        let aPOs = [];

        if (Array.isArray(data)) {

            aPOs = data;

        } else if (Array.isArray(data.value)) {

            aPOs = data.value;

        } else if (Array.isArray(data.POs)) {

            aPOs = data.POs;

        }

        console.log("PO COUNT:", aPOs.length);

        this._setPOData(aPOs);

    } catch (error) {

        console.error("PO STATUS ERROR");
        console.error(error);

        this._setPOData([]);

        MessageToast.show(
            "Failed to load PO Status"
        );

    }

},
            
            /* SET MODEL */
            

            _setPOData: function (aPOs) {

                var oModel =
                    this.getView()
                        .getModel("poStatus");

                oModel.setProperty(
                    "/POs",
                    aPOs
                );

                oModel.setProperty(
                    "/totalPOs",
                    aPOs.length
                );

                console.log(
                    "TOTAL PO RECORDS:",
                    aPOs.length
                );

                this._calculateKPIs(
                    aPOs
                );

            },

            
            /* KPI COUNTS  */
            

            _calculateKPIs: function (aPOs) {

                var iOutputSuccess = 0;
                var iOutputFailed = 0;
                var iOpenGRN = 0;
                var iCompletedGRN = 0;

                aPOs.forEach(function (oPO) {

                    if (
                        oPO.POVendorConfStatus ===
                        "SUCCESS"
                    ) {
                        iOutputSuccess++;
                    }

                    if (
                        oPO.POVendorConfStatus ===
                        "ERROR"
                    ) {
                        iOutputFailed++;
                    }

                    if (
                        oPO.GRNStatus ===
                        "OPEN"
                    ) {
                        iOpenGRN++;
                    }

                    if (
                        oPO.GRNStatus ===
                        "COMPLETED"
                    ) {
                        iCompletedGRN++;
                    }

                });

                var oModel =
                    this.getView()
                        .getModel("poStatus");

                oModel.setProperty(
                    "/outputSuccess",
                    iOutputSuccess
                );

                oModel.setProperty(
                    "/outputFailed",
                    iOutputFailed
                );

                oModel.setProperty(
                    "/openGRN",
                    iOpenGRN
                );

                oModel.setProperty(
                    "/completedGRN",
                    iCompletedGRN
                );

            },

            
            /* SEARCH */
            

            onSearch: function (oEvent) {

                var sValue =
                    oEvent.getParameter(
                        "newValue"
                    ) || "";

                var oTable =
                    this.byId("poTable");

                var oBinding =
                    oTable.getBinding(
                        "items"
                    );

                if (!sValue) {

                    oBinding.filter([]);
                    return;

                }

                oBinding.filter([

                    new Filter({

                        filters: [

                            new Filter(
                                "PONumber",
                                FilterOperator.Contains,
                                sValue
                            ),

                            new Filter(
                                "PurReqNumber",
                                FilterOperator.Contains,
                                sValue
                            ),

                            new Filter(
                                "Vendor",
                                FilterOperator.Contains,
                                sValue
                            ),

                            new Filter(
                                "VendorName",
                                FilterOperator.Contains,
                                sValue
                            ),

                            new Filter(
                                "CreatedBy",
                                FilterOperator.Contains,
                                sValue
                            )

                        ],

                        and: false

                    })

                ]);

            },

           
            /* ROW PRESS */
            

            onRowPress: function (oEvent) {

                var oPO =
                    oEvent.getSource()
                        .getBindingContext(
                            "poStatus"
                        )
                        .getObject();

                console.log(
                    "SELECTED PO"
                );

                console.log(oPO);

            },

            
            /* REFRESH  */
            

    onRefresh: async function () {

    await this._loadPOStatus();

    MessageToast.show(
        "PO Status Refreshed"
    );

},

            
               /* BACK */
            

            onNavBack: function () {

                this.getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "RouteDashboard"
                    );

            }

        }

    );

});