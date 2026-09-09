using { prpo.db as db } from '../db/schema';

service PRPOService {

    /* Database Entities */

    entity PRData as projection on db.PRData;

    entity POData as projection on db.POData;

    /* Response Structures */

    entity PRRecord {
        key PurReqNumber      : String;
        key PurReqItemNo      : String;

        PRItemDesc            : String;
        MaterialNo            : String;

        FixedVendor           : String;
        FixedVendorName       : String;

        OrderQuantity         : String;
        UnitOfMeasure         : String;
        Valuation_Price       : String;

        PlantCode             : String;
        PurchasingOrg         : String;
        PurchasingGrp         : String;

        Currency              : String;
        MrpController         : String;

        DeliveryDate          : String;

        DocumentType          : String;
        ItemCategory          : String;
        AcctAssignCat         : String;

        Status                : String;
        ErrorMessage          : String;

        ChangeAccess          : String;
        RequestorUser         : String;
        EmailAddress          : String;
    }

    entity POStatus {

        key PONumber          : String;

        LineNumber            : String;

        PurReqNumber          : String;
        PurReqItemNo          : String;

        Vendor                : String;
        VendorName            : String;

        Plant                 : String;

        POQty                 : String;
        PRQty                 : String;

        GRNQty                : String;
        GRNStatus             : String;

        POVendorConfStatus    : String;

        CreatedBy             : String;

        PODelDate             : String;
        GRNDate               : String;
    }

    /* Actions */

    action getPRData(
        userId : String
    ) returns many PRRecord;

    action getPOStatus(
        userId : String
    ) returns many POStatus;

    action convertPRsToPO(
        userId : String,
        items  : many PRRecord
    ) returns String;

    action UpdatePR(
    PRs : many {
        PurReqNumber  : String;
        PurReqItemNo  : String;
        Quantity      : String;
        DeliveryDate  : String;
        Vendor        : String;
    }
) returns String;

    action DeletePR(
        PRNumbers : many String
    ) returns String;

    action RestorePR(
        PRNumbers : many String
    ) returns String;

}