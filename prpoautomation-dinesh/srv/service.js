const cds = require("@sap/cds");

module.exports = cds.service.impl(async function () {

    const db = await cds.connect.to("db");

    await cds.deploy("db/schema.cds").to(db);

    const ecc = await cds.connect.to("ZMM_STO_PR_PO_SRV");

    const { PRData, POData } =
        cds.entities("prpo.db");

   
    /* ===================================================== */
    /* TEST DB                                               */
    /* ===================================================== */

    this.on("testDB", async () => {

        return await db.run(
            SELECT.one`1 as STATUS`
        );

    });
     
    /* Check Tables */

    this.on("checkTables", async () => {

    return await db.run(`
        SELECT table_name
        FROM information_schema.tables
        ORDER BY table_name
    `);

});
    /* ===================================================== */
    /* GET PR DATA                                           */
    /* ===================================================== */

    this.on("getPRData", async (req) => {

        try {

            const userId = req.data.userId;

            const result = await ecc.send({
                method: "GET",
                path:
                    `/Users?$filter=UserName eq '${userId}'` +
                    `&$expand=Nav_PRData` +
                    `&sap-client=400` +
                    `&sap-language=EN`
            });

            const aPRs =
                result?.[0]?.Nav_PRData || [];

            for (const pr of aPRs) {

                await UPSERT
                    .into(PRData)
                    .entries({

                        PurReqNumber: pr.PurReqNumber,
                        PurReqItemNo: pr.PurReqItemNo,

                        PRItemDesc: pr.PRItemDesc,
                        MaterialNo: pr.MaterialNo,

                        FixedVendor: pr.FixedVendor,
                        FixedVendorName: pr.FixedVendorName,

                        OrderQuantity: pr.OrderQuantity,
                        UnitOfMeasure: pr.UnitOfMeasure,

                        Valuation_Price: pr.Valuation_Price,

                        PlantCode: pr.PlantCode,
                        PurchasingOrg: pr.PurchasingOrg,
                        PurchasingGrp: pr.PurchasingGrp,

                        Currency: pr.Currency,
                        MrpController: pr.MrpController,

                        DeliveryDate: pr.DeliveryDate,

                        DocumentType: pr.DocumentType,
                        ItemCategory: pr.ItemCategory,
                        AcctAssignCat: pr.AcctAssignCat,

                        Status: pr.Status,
                        ErrorMessage: pr.ErrorMessage,

                        ChangeAccess: pr.ChangeAccess,
                        RequestorUser: pr.RequestorUser,
                        EmailAddress: pr.EmailAddress,

                        LastSyncedAt: new Date()

                    });

            }

            return aPRs;

        } catch (error) {

            console.error("GET PR DATA ERROR");
            console.error(error);

            return [];

        }

    });

/* ===================================================== */
/* GET PO STATUS                                         */
/* ===================================================== */

this.on("getPOStatus", async () => {

    try {

        const aPOs = await db.run(
            SELECT.from(POData)
        );

        console.log("================================");
        console.log("GET PO STATUS");
        console.log("PO COUNT:", aPOs.length);
        console.log(JSON.stringify(aPOs, null, 2));
        console.log("================================");

        return aPOs;

    } catch (error) {

        console.error(
            "GET PO STATUS ERROR"
        );

        console.error(error);

        return [];

    }

});


/* ===================================================== */
/* CONVERT PR TO PO                                      */
/* ===================================================== */

this.on("convertPRsToPO", async (req) => {

    try {

        const { items, userId } = req.data;

        console.log("==================================");
        console.log("CONVERT PR TO PO");
        console.log("USER:", userId);
        console.log("ITEM COUNT:", items?.length);
        console.log("==================================");

        if (!items || !items.length) {
            return req.error(
                400,
                "No PR selected"
            );
        }

        const groupedPRs = {};

        items.forEach(pr => {

            const deliveryDate =
                String(
                    pr.DeliveryDate || ""
                ).trim();

            if (!groupedPRs[deliveryDate]) {
                groupedPRs[deliveryDate] = [];
            }

            groupedPRs[deliveryDate].push(pr);

        });

        console.log(
            "GROUP COUNT:",
            Object.keys(groupedPRs).length
        );

        const allResults = [];
        const poNumbers = [];

        for (const deliveryDate of Object.keys(groupedPRs)) {

            const prGroup =
                groupedPRs[deliveryDate];

            const payload = {

                UserName: String(userId),

                Nav_PRsToPOs: {

                    results: prGroup.map(pr => ({

                        PurReqNumber:
                            String(
                                pr.PurReqNumber || ""
                            ).trim(),

                        PurReqItemNo:
                            String(
                                pr.PurReqItemNo || ""
                            ).trim()

                    }))

                },

                Nav_Return: {
                    results: []
                }

            };

            console.log("================================");
            console.log(
                "DELIVERY DATE:",
                deliveryDate
            );
            console.log(
                "ITEMS:",
                prGroup.length
            );
            console.log("SAP PAYLOAD START");
            console.log(
                JSON.stringify(
                    payload,
                    null,
                    2
                )
            );
            console.log("SAP PAYLOAD END");
            console.log("================================");

            const result = await ecc.tx(req).send({

                method: "POST",

                path: "/PRsPOSs",

                data: payload

            });

            console.log("================================");
            console.log("SAP RESPONSE START");
            console.log(
                JSON.stringify(
                    result,
                    null,
                    2
                )
            );
            console.log("SAP RESPONSE END");
            console.log("================================");

            let createdPONumber = "";

            const messages =
                result?.Nav_Return?.results ||
                result?.Nav_Return ||
                [];

            for (const msg of messages) {

                if (
                    msg.MsgType === "S" &&
                    msg.MsgText
                ) {

                    const match =
                        msg.MsgText.match(
                            /\b\d{10}\b/
                        );

                    if (match) {

                        createdPONumber =
                            match[0];

                        poNumbers.push(
                            createdPONumber
                        );

                        break;
                    }
                }

                if (
                    msg.MsgType === "E"
                ) {

                    console.error(
                        "ECC ERROR:",
                        msg.MsgText
                    );
                }
            }

            console.log(
                "CREATED PO:",
                createdPONumber
            );
            
            /* SAVE PO TO POSTGRES */

if (createdPONumber) {

    await UPSERT
        .into(POData)
        .entries({

            PONumber:
                createdPONumber,

            LineNumber:
                "00010",

            PurReqNumber:
                prGroup[0].PurReqNumber,

            PurReqItemNo:
                prGroup[0].PurReqItemNo,

            Vendor:
                prGroup[0].FixedVendor,

            VendorName:
                prGroup[0].FixedVendorName,

            Plant:
                prGroup[0].PlantCode,

            POQty:
                String(
                    prGroup.reduce(
                        (sum, pr) =>
                            sum +
                            Number(
                                pr.OrderQuantity || 0
                            ),
                        0
                    )
                ),

            PRQty:
                String(
                    prGroup.reduce(
                        (sum, pr) =>
                            sum +
                            Number(
                                pr.OrderQuantity || 0
                            ),
                        0
                    )
                ),

            GRNQty:
                "0",

            GRNStatus:
                "OPEN",

            POVendorConfStatus:
                "SUCCESS",

            CreatedBy:
                userId,

            PODelDate:
                deliveryDate,

            GRNDate:
                "",

            CreatedAt:
                new Date()

        });

}
            allResults.push({

                DeliveryDate:
                    deliveryDate,

                PONumber:
                    createdPONumber,

                Result:
                    result

            });

        }

        return {

            Success: true,

            GroupCount:
                Object.keys(
                    groupedPRs
                ).length,

            PONumbers:
                poNumbers,

            Results:
                allResults

        };

    } catch (error) {

        console.error("================================");
        console.error("CONVERT PR TO PO ERROR");
        console.error("================================");

        console.error(
            error?.message
        );

        console.error(
            JSON.stringify(
                error?.response?.data || {},
                null,
                2
            )
        );

        return req.error(
            500,
            error?.message ||
            "PO Creation Failed"
        );

    }

});

    /* ===================================================== */
/* UPDATE PR                                             */
/* ===================================================== */

this.on("UpdatePR", async (req) => {

    try {

        console.log("UPDATE PR REQUEST");
        console.log(JSON.stringify(req.data, null, 2));

        const { PRs } = req.data;

        if (!PRs || !PRs.length) {
            return req.error(400, "No PR data received");
        }

        for (const pr of PRs) {

            await UPDATE(PRData)
    .set({
        OrderQuantity: pr.Quantity,
        DeliveryDate: pr.DeliveryDate,
        FixedVendor: pr.Vendor,
        FixedVendorName: pr.Vendor,
        LastSyncedAt: new Date()
    })
    .where({
        PurReqNumber: pr.PurReqNumber,
        PurReqItemNo: pr.PurReqItemNo
    });


            console.log(
                `Updated PR ${pr.PurReqNumber}/${pr.PurReqItemNo}`
            );
        }

        return {
            Success: true,
            Message: "PR Updated Successfully"
        };

    } catch (error) {

        console.error("UPDATE PR ERROR");
        console.error(error);

        return req.error(
            500,
            error.message || "PR Update Failed"
        );
    }

});

    /* ===================================================== */
    /* DELETE PR                                             */
    /* ===================================================== */

    this.on("DeletePR", async (req) => {

        try {

            console.log(
                "DELETE PR REQUEST"
            );

            console.log(
                JSON.stringify(
                    req.data,
                    null,
                    2
                )
            );

            /*
             * TODO:
             * ECC Delete/Block PR
             */

            return "Delete Request Submitted";

        } catch (error) {

            console.error(error);

            return "Delete Failed";

        }

    });

    /* ===================================================== */
    /* RESTORE PR                                            */
    /* ===================================================== */

    this.on("RestorePR", async (req) => {

        try {

            console.log(
                "RESTORE PR REQUEST"
            );

            console.log(
                JSON.stringify(
                    req.data,
                    null,
                    2
                )
            );

            /*
             * TODO:
             * ECC Restore PR
             */

            return "Restore Request Submitted";

        } catch (error) {

            console.error(error);

            return "Restore Failed";

        }

    });

});