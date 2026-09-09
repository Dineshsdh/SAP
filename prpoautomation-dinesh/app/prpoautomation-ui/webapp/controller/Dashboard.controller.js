sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (
    Controller,
    Fragment,
    JSONModel,
    Filter,
    FilterOperator,
    MessageBox,
    MessageToast
) {
    "use strict";
 
    return Controller.extend(
        "prpoautomation.controller.Dashboard",
        {
 
            /* INIT */
            
 
            onInit: function () {
 
                var oDashboardModel = new JSONModel({

    prs: [],
    selectedPR: null,

    totalPRs: 0,
    readyPRs: 0,
    errorPRs: 0,
    deletedPRs: 0,
    createdPOs: 0,
    pendingGRs: 0,

    selectedCount: 0,
    selectedQuantity: 0,
    selectedValue: 0,

    plants: [],
    mrps: []
});
 
                this.getView().setModel(
                    oDashboardModel,
                    "dashboard"
                );
 
                this._loadPRData();
            },
 
 
        
            /* LOAD SAP ODATA DATA */
            
 
         _loadPRData: function () {

        fetch("/odata/v4/prpo/getPRData", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            userId: "1309034"
        })
    })
    .then(response => response.json())

    .then(function (data) {

        console.log("FULL RESPONSE");
        console.log(data);

        console.log("DATA TYPE");
        console.log(typeof data);

        console.log("KEYS");
        console.log(Object.keys(data));

        console.log("VALUE");
        console.log(data.value);

        var aPRs = data.value || [];

        console.log("PR Records:", aPRs);
        console.log("Count:", aPRs.length);

        this._setPRData(aPRs);

        console.log(
            "Table Items:",
            this.byId("prTable")
                .getBinding("items")
        );

    }.bind(this))

    .catch(function (error) {

        console.error("LOAD ERROR");
        console.error(error);

    });

},
 
 
            
            /* SET PR DATA */
           
 
    _setPRData: function (aPRData) {

    console.log("SET PR DATA");
    console.log(aPRData);
    console.log("COUNT:", aPRData.length);

    if (!Array.isArray(aPRData)) {
        console.error("Expected array but received:", aPRData);
        return;
    }

    var oDashboardModel =
        this.getView().getModel("dashboard");

    if (!oDashboardModel) {
        console.error("Dashboard model not found");
        return;
    }

    oDashboardModel.setProperty("/prs", aPRData);
    oDashboardModel.setProperty("/totalPRs", aPRData.length);

    console.log("Dashboard Model Data");
    console.log(oDashboardModel.getData());

    this._createFilterValues(aPRData);
    this._calculateStatusCounts(aPRData);
},
 
 
            
            /* CREATE FILTER VALUES */
          
 
            _createFilterValues: function (aPRData) {

                if (!Array.isArray(aPRData)) {
                    console.error("Expected array but received:", aPRData);
                    return;
                }
            
                var aPlants = [];
                var aMRPs = [];
            
                aPRData.forEach(function (oPR) {
 
                    /* Plant */
 
                    if (
                        oPR.PlantCode &&
                        !aPlants.some(function (oItem) {
                            return oItem.key ===
                                oPR.PlantCode;
                        })
                    ) {
 
                        aPlants.push({
                            key: oPR.PlantCode,
                            text: oPR.PlantCode
                        });
                    }
 
 
                    /* MRP Controller */
 
                    if (
                        oPR.MrpController &&
                        !aMRPs.some(function (oItem) {
                            return oItem.key ===
                                oPR.MrpController;
                        })
                    ) {
 
                        aMRPs.push({
                            key: oPR.MrpController,
                            text: oPR.MrpController
                        });
                    }
 
                });
 
                var oDashboardModel =
                    this.getView().getModel("dashboard");
 
                oDashboardModel.setProperty(
                    "/plants",
                    aPlants
                );
 
                oDashboardModel.setProperty(
                    "/mrps",
                    aMRPs
                );
            },
 
 
            
            /* KPI STATUS COUNTS */
            
 
           _calculateStatusCounts: function (aPRData) {

    let ready = 0;
    let error = 0;
    let deleted = 0;

    aPRData.forEach(function (oPR) {

            if (
         oPR.FixedVendor &&
         oPR.Currency &&
         oPR.OrderQuantity
         ) {
             ready++;
         }

        if (!oPR.FixedVendor) {
            error++;
        }

        if (
            oPR.Status === "DELETED"
        ) {
            deleted++;
        }

    });

    var oModel =
        this.getView()
            .getModel("dashboard");

    oModel.setProperty(
        "/readyPRs",
        ready
    );

    oModel.setProperty(
        "/errorPRs",
        error
    );

    oModel.setProperty(
        "/deletedPRs",
        deleted
    );
},
 
 
            
            /* SEARCH  */
            
 
            onSearch: function (oEvent) {
 
                var sValue =
                    oEvent.getParameter("newValue") || "";
 
                sValue =
                    sValue.trim();
 
                var oTable =
                    this.byId("prTable");
 
                if (!oTable) {
                    return;
                }
 
                var oBinding =
                    oTable.getBinding("items");
 
                if (!oBinding) {
                    return;
                }
 
 
                if (!sValue) {
 
                    oBinding.filter([]);
 
                    return;
                }
 
 
                var oSearchFilter =
                    new Filter({
 
                        filters: [
 
                            new Filter(
                                "PurReqNumber",
                                FilterOperator.Contains,
                                sValue
                            ),
 
                            new Filter(
                                "PurReqItemNo",
                                FilterOperator.Contains,
                                sValue
                            ),
 
                            new Filter(
                                "MaterialNo",
                                FilterOperator.Contains,
                                sValue
                            ),
 
                            new Filter(
                                "PRItemDesc",
                                FilterOperator.Contains,
                                sValue
                            ),
                            
                            new Filter(
                                "FixedVendorName",
                                FilterOperator.Contains,
                                sValue
                            ),
 
                            new Filter(
                                "PlantCode",
                                FilterOperator.Contains,
                                sValue
                            )
 
                        ],
 
                        and: false
                    });
 
 
                oBinding.filter([
                    oSearchFilter
                ]);
            },
 
 
            
            /* PLANT + MRP FILTER  */
            
 
            onFilterChange: function () {
 
                var aFilters = [];
 
                var oPlantFilter =
                    this.byId("plantFilter");
 
                var oMRPFilter =
                    this.byId("mrpFilter");
 
 
                /* Plant */
 
                if (oPlantFilter) {
 
                    var oPlantItem =
                        oPlantFilter.getSelectedItem();
 
                    if (oPlantItem) {
 
                        var sPlant =
                            oPlantItem.getKey();
 
                        if (sPlant) {
 
                            aFilters.push(
                                new Filter(
                                    "PlantCode",
                                    FilterOperator.EQ,
                                    sPlant
                                )
                            );
                        }
                    }
                }
 
 
                /* MRP */
 
                if (oMRPFilter) {
 
                    var oMRPItem =
                        oMRPFilter.getSelectedItem();
 
                    if (oMRPItem) {
 
                        var sMRP =
                            oMRPItem.getKey();
 
                        if (sMRP) {
 
                            aFilters.push(
                                new Filter(
                                    "MrpController",
                                    FilterOperator.EQ,
                                    sMRP
                                )
                            );
                        }
                    }
                }
 
 
                var oTable =
                    this.byId("prTable");
 
                if (!oTable) {
                    return;
                }
 
                var oBinding =
                    oTable.getBinding("items");
 
                if (oBinding) {
                    oBinding.filter(aFilters);
                }
            },
 
 
            
            /* SELECTION */
            
 
            onSelectionChange: function () {
 
                var oTable =
                    this.byId("prTable");
 
                var aSelectedItems =
                    oTable.getSelectedItems();
 
                var fQty = 0;
var fValue = 0;

aSelectedItems.forEach(function (oItem) {

    var oContext =
        oItem.getBindingContext(
            "dashboard"
        );

    if (!oContext) {
        return;
    }

    var oPR =
        oContext.getObject();

    fQty += Number(
        oPR.OrderQuantity || 0
    );

    fValue +=
        Number(
            oPR.OrderQuantity || 0
        ) *
        Number(
            oPR.Valuation_Price || 0
        );

});

var oDashboardModel =
    this.getView().getModel(
        "dashboard"
    );

oDashboardModel.setProperty(
    "/selectedCount",
    aSelectedItems.length
);

oDashboardModel.setProperty(
    "/selectedQuantity",
    fQty
);

oDashboardModel.setProperty(
    "/selectedValue",
    fValue
);
},
 
 
            
            /* CREATE PO DIALOG */
            
 onCreatePO: async function () {

    var oTable = this.byId("prTable");

    var aSelectedItems =
        oTable.getSelectedItems();

    if (!aSelectedItems.length) {

        MessageBox.warning(
            "Please select at least one PR."
        );

        return;
    }

    var aSelectedPRs = [];

    aSelectedItems.forEach(function (oItem) {

        var oContext =
            oItem.getBindingContext(
                "dashboard"
            );

        if (oContext) {
            aSelectedPRs.push(
                oContext.getObject()
            );
        }

    });

    if (!aSelectedPRs.length) {
        return;
    }

    const sPRNumber =
        aSelectedPRs[0].PurReqNumber;

    const bDifferentPR =
        aSelectedPRs.some(function (oPR) {

            return (
                oPR.PurReqNumber !==
                sPRNumber
            );

        });

    if (bDifferentPR) {

        MessageBox.warning(
            "Please select items belonging to the same PR Number."
        );

        return;
    }

    var oModel =
        this.getView()
            .getModel("dashboard");

    /* First PR for dialog display */
    oModel.setProperty(
        "/selectedPR",
        {
            PurReqNumber: sPRNumber,
            PurReqItemNo: aSelectedPRs
                .map(pr => pr.PurReqItemNo)
                .join(", "),
            MaterialNo: aSelectedPRs[0].MaterialNo,
            FixedVendorName:
                aSelectedPRs[0].FixedVendorName,
            PlantCode:
                aSelectedPRs[0].PlantCode,
            OrderQuantity:
                aSelectedPRs.reduce(
                    (sum, pr) =>
                        sum +
                        Number(
                            pr.OrderQuantity || 0
                        ),
                    0
                )
        }
    );

    /* All selected PRs for PO creation */

    oModel.setProperty(
        "/selectedPRs",
        aSelectedPRs
    );

    console.log(
        "SELECTED PR",
        oModel.getProperty(
            "/selectedPR"
        )
    );

    if (!this._oCreatePODialog) {

        this._oCreatePODialog =
            await Fragment.load({

                name:
                    "prpoautomation.fragment.CreatePO",

                controller:
                    this

            });

        this.getView()
            .addDependent(
                this._oCreatePODialog
            );
    }

    this._oCreatePODialog.open();
},
            
            /* CONFIRM CREATE PO */
           
 
onConfirmCreatePO: async function () {

    var oTable = this.byId("prTable");

    var aSelectedItems = oTable.getSelectedItems();

    if (!aSelectedItems.length) {

        MessageBox.warning(
            "Please select at least one PR."
        );

        return;
    }

    var aPRs = [];

    aSelectedItems.forEach(function (oItem) {

        var oPR = oItem
            .getBindingContext("dashboard")
            .getObject();

        aPRs.push({
            PurReqNumber: oPR.PurReqNumber,
            PurReqItemNo: oPR.PurReqItemNo,
            PRItemDesc: oPR.PRItemDesc,
            MaterialNo: oPR.MaterialNo,
            FixedVendor: oPR.FixedVendor,
            OrderQuantity: String(oPR.OrderQuantity || "").trim(),
            UnitOfMeasure: oPR.UnitOfMeasure,
            Currency: oPR.Currency,
            PlantCode: oPR.PlantCode,
            PurchasingOrg: oPR.PurchasingOrg,
            PurchasingGrp: oPR.PurchasingGrp,
            DeliveryDate: oPR.DeliveryDate,
            DocumentType: oPR.DocumentType,
            ItemCategory: oPR.ItemCategory,
            AcctAssignCat: oPR.AcctAssignCat,
            Valuation_Price: oPR.Valuation_Price,
            MrpController: oPR.MrpController
        });

    });

    try {

        const response = await fetch(
            "/odata/v4/prpo/convertPRsToPO",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    userId: "1309034",
                    items: aPRs
                })
            }
        );

        const result = await response.json();

        const poNumbers = result?.PONumbers || [];

        if (poNumbers.length > 0) {

            MessageBox.success(
                "PO Created Successfully\n\nPO Number(s):\n\n" +
                poNumbers.join("\n"),
                {
                    title: "PO Creation",
                    onClose: function () {

                        this._loadPRData();

                        if (this._oCreatePODialog) {
                            this._oCreatePODialog.close();
                        }

                        oTable.removeSelections(true);

                    }.bind(this)
                }
            );

            return;
        }

        let aErrors = [];

        if (result?.Results) {

            result.Results.forEach(function (oGroup) {

                const aMessages =
                    oGroup?.Result?.Nav_Return?.results ||
                    oGroup?.Result?.Nav_Return ||
                    [];

                aMessages.forEach(function (oMsg) {

                    if (oMsg.MsgType === "E") {
                        aErrors.push(oMsg.MsgText);
                    }

                });

            });

        }

        MessageBox.error(
            aErrors.length
                ? aErrors.join("\n")
                : "PO Creation Failed",
            {
                title: "ECC Error"
            }
        );

    } catch (e) {

        console.error("PO CREATION ERROR", e);

        MessageBox.error(
            e.message || "PO Creation Failed"
        );

    }

},


     /* CANCEL CREATE PO */


onCancelCreatePO: function () {

    var oTable = this.byId("prTable");

    if (oTable) {
        oTable.removeSelections(true);
    }

    if (this._oCreatePODialog) {
        this._oCreatePODialog.close();
    }

},
           
            /* EDIT PR DIALOG */
            
 onEdit: async function () {

    var oTable =
        this.byId("prTable");

    var aSelectedItems =
        oTable.getSelectedItems();

    if (!aSelectedItems.length) {

        MessageBox.warning(
            "Please select at least one PR."
        );

        return;
    }

    var aSelectedPRs = [];

    aSelectedItems.forEach(function (oItem) {

        var oContext =
            oItem.getBindingContext(
                "dashboard"
            );

        if (oContext) {
            aSelectedPRs.push(
                oContext.getObject()
            );
        }

    });

    if (!aSelectedPRs.length) {
        return;
    }

    var oModel =
        this.getView()
            .getModel("dashboard");

    oModel.setProperty(
        "/selectedPR",
        {

            PurReqNumber:
                aSelectedPRs
                    .map(function (oPR) {
                        return oPR.PurReqNumber;
                    })
                    .filter(
                        (v, i, a) =>
                            a.indexOf(v) === i
                    )
                    .join(", "),

            PurReqItemNo:
                aSelectedPRs
                    .map(function (oPR) {
                        return oPR.PurReqItemNo;
                    })
                    .join(", "),

            MaterialNo:
                aSelectedPRs[0]
                    .MaterialNo,

            PRItemDesc:
                aSelectedPRs[0]
                    .PRItemDesc,

            FixedVendorName:
                aSelectedPRs[0]
                    .FixedVendorName,

            PlantCode:
                aSelectedPRs[0]
                    .PlantCode,

            DeliveryDate:
                aSelectedPRs[0]
                    .DeliveryDate,

            OrderQuantity:
                aSelectedPRs.reduce(
                    function (
                        total,
                        oPR
                    ) {

                        return (
                            total +
                            Number(
                                oPR.OrderQuantity || 0
                            )
                        );

                    },
                    0
                )

        }
    );

    oModel.setProperty(
        "/selectedPRs",
        aSelectedPRs
    );

    console.log(
        "SELECTED PRS",
        aSelectedPRs
    );

    if (!this._oEditPRDialog) {

        this._oEditPRDialog =
            await Fragment.load({

                name:
                    "prpoautomation.fragment.EditPR",

                controller:
                    this

            });

        this.getView()
            .addDependent(
                this._oEditPRDialog
            );
    }

    this._oEditPRDialog.open();

},
 
 
            
            /* SAVE EDIT  */
            
 
onSaveEditPR: async function () {

    var oModel = this.getView().getModel("dashboard");

    var oSelectedPR = oModel.getProperty("/selectedPR");
    var aSelectedPRs = oModel.getProperty("/selectedPRs");

    if (!aSelectedPRs || !aSelectedPRs.length) {
        return;
    }

    try {

        const aPayload = aSelectedPRs.map(function (oPR) {
            return {
                PurReqNumber: oPR.PurReqNumber,
                PurReqItemNo: oPR.PurReqItemNo,
                Quantity: oSelectedPR.OrderQuantity,
                DeliveryDate: oSelectedPR.DeliveryDate,
                Vendor: oSelectedPR.FixedVendorName
            };
        });

        console.log("UPDATE PR REQUEST", aPayload);

        const response = await fetch(
            "/odata/v4/prpo/UpdatePR",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    PRs: aPayload
                })
            }
        );

        const result = await response.json();

        console.log("UPDATE PR RESPONSE", result);

        if (!response.ok) {
            throw new Error(result.error || "Update Failed");
        }

        MessageToast.show("PR Updated Successfully");

        this._loadPRData();

        if (this._oEditPRDialog) {
            this._oEditPRDialog.close();
        }

        this.byId("prTable").removeSelections(true);

    } catch (e) {

        console.error(e);

        MessageBox.error(
            e.message || "PR Update Failed"
        );
    }
},

            
            /* ERROR LOG DIALOG */
            
 onErrorLog: function () {

    var oTable = this.byId("prTable");

    var aSelectedItems =
        oTable.getSelectedItems();

    if (!aSelectedItems.length) {

        MessageBox.warning(
            "Please select at least one PR."
        );

        return;
    }

    var aErrors = [];

    aSelectedItems.forEach(function (oItem) {

        var oPR =
            oItem
                .getBindingContext("dashboard")
                .getObject();

        aErrors.push(

            "PR Number : " +
            (oPR.PurReqNumber || "") +

            "\nPR Item : " +
            (oPR.PurReqItemNo || "") +

            "\nStatus : " +
            (oPR.Status || "") +

            "\nError : " +
            (oPR.ErrorMessage ||
             "No Error Message")

        );

    });

    MessageBox.error(
        aErrors.join("\n\n--------------------------------\n\n"),
        {
            title: "PR Error Log"
        }
    );

},
 
 
            
            /* DELETE  */
        
 
           onDelete: async function () {

    var oTable =
        this.byId("prTable");

    var aSelectedItems =
        oTable.getSelectedItems();

    if (!aSelectedItems.length) {

        MessageBox.warning(
            "Select at least one PR"
        );

        return;
    }

    var aPRs = [];

    aSelectedItems.forEach(function (oItem) {

        var oPR =
            oItem
                .getBindingContext("dashboard")
                .getObject();

        aPRs.push({
            PurReqNumber:
                oPR.PurReqNumber,
            PurReqItemNo:
                oPR.PurReqItemNo
        });

    });


    MessageBox.confirm(

        "Are you sure you want to delete the selected PR(s)?",

        {
            title: "Confirm Delete",

            actions: [
                MessageBox.Action.YES,
                MessageBox.Action.NO
            ],

            onClose: async function (sAction) {

                if (
                    sAction !==
                    MessageBox.Action.YES
                ) {
                    return;
                }
                
               this._deletedPRs = this._deletedPRs || [];

this._deletedPRs.push(
    ...aSelectedItems.map(function (oItem) {
        return oItem
            .getBindingContext("dashboard")
            .getObject();
    })
);
                
                try {

                    const response =
                        await fetch(
                            "/odata/v4/prpo/DeletePR",
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type":
                                        "application/json"
                                },
                                body: JSON.stringify({
                                    PRs: aPRs
                                })
                            }
                        );

                    const result =
                        await response.json();

                    console.log(
                        "DELETE RESPONSE",
                        result
                    );

                    /* Remove deleted records from table model */

                    var oModel =
                        this.getView()
                            .getModel(
                                "dashboard"
                            );

                    var aCurrentPRs =
                        oModel.getProperty(
                            "/prs"
                        ) || [];

                    var aRemainingPRs =
                        aCurrentPRs.filter(
                            function (oPR) {

                                return !aPRs.some(
                                    function (
                                        oDeleted
                                    ) {

                                        return (
                                            oDeleted.PurReqNumber ===
                                                oPR.PurReqNumber &&
                                            oDeleted.PurReqItemNo ===
                                                oPR.PurReqItemNo
                                        );

                                    }
                                );

                            }
                        );

                    oModel.setProperty(
                        "/prs",
                        aRemainingPRs
                    );

                    oModel.setProperty(
                        "/totalPRs",
                        aRemainingPRs.length
                    );

                    oTable.removeSelections(
                        true
                    );

                    MessageToast.show(
                        "PR(s) Deleted Successfully"
                    );

                } catch (e) {

                    console.error(e);

                    MessageBox.error(
                        e.message ||
                        "Delete Failed"
                    );

                }

            }.bind(this)

        }

    );

},
 
 
            
            /* RESTORE */
          
 
  onRestore: async function () {

    if (
        !this._deletedPRs ||
        !this._deletedPRs.length
    ) {

        MessageBox.warning(
            "No deleted PRs available for restore."
        );

        return;
    }

    try {

        const response =
            await fetch(
                "/odata/v4/prpo/RestorePR",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body: JSON.stringify({
                        PRs: this._deletedPRs
                    })
                }
            );

        await response.json();

        var oModel =
            this.getView()
                .getModel("dashboard");

        var aCurrentPRs =
            oModel.getProperty("/prs") || [];

        var aRestoredPRs =
            [...aCurrentPRs, ...this._deletedPRs];

        oModel.setProperty(
            "/prs",
            aRestoredPRs
        );

        oModel.setProperty(
            "/totalPRs",
            aRestoredPRs.length
        );

        this._calculateStatusCounts(
            aRestoredPRs
        );

        this._createFilterValues(
            aRestoredPRs
        );

        this._deletedPRs = [];

        this.byId("prTable")
            .removeSelections(true);

        MessageToast.show(
            "PR(s) Restored Successfully"
        );

    } catch (e) {

        console.error(e);

        MessageBox.error(
            e.message ||
            "Restore Failed"
        );

    }

},
 
            /* ErrorLog  */
            
        onErrorLog: function () {

    var aSelected =
        this.byId("prTable")
            .getSelectedItems();

    if (aSelected.length !== 1) {

        MessageBox.warning(
            "Select one PR"
        );

        return;
    }

    var oPR =
        aSelected[0]
            .getBindingContext(
                "dashboard"
            )
            .getObject();

    MessageBox.error(
        oPR.ErrorMessage ||
        "No Errors Found"
    );

},
           /* PO Status Navigation */

           onPOStatus: function () {

    this.getOwnerComponent()
        .getRouter()
        .navTo(
            "RoutePOStatus"
        );

},
            
            /* REFRESH */
            
 
            onRefresh: function () {

    var oTable =
        this.byId("prTable");

    if (oTable) {

        oTable.removeSelections(
            true
        );

    }

    var oDashboardModel =
        this.getView()
            .getModel("dashboard");

    oDashboardModel.setProperty(
        "/selectedCount",
        0
    );

    oDashboardModel.setProperty(
        "/selectedQuantity",
        0
    );

    oDashboardModel.setProperty(
        "/selectedValue",
        0
    );

    this._loadPRData();

    MessageToast.show(
        "PR Data Refreshed"
    );

}
 
        }
    );
});