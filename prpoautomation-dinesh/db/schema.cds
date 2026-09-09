namespace prpo.db;

entity PRData {

    key PurReqNumber      : String(20);
    key PurReqItemNo      : String(10);

    PRItemDesc            : String(255);
    MaterialNo            : String(40);

    FixedVendor           : String(20);
    FixedVendorName       : String(255);

    OrderQuantity         : String(20);
    UnitOfMeasure         : String(10);

    Valuation_Price       : String(20);

    PlantCode             : String(10);

    PurchasingOrg         : String(10);
    PurchasingGrp         : String(10);

    Currency             : String(10);
    MrpController        : String(20);

    DeliveryDate         : String(20);

    DocumentType         : String(10);
    ItemCategory         : String(10);
    AcctAssignCat        : String(10);

    Status              : String(50);
    ErrorMessage        : String(500);

    ChangeAccess        : String(10);
    RequestorUser       : String(50);
    EmailAddress        : String(255);

    LastSyncedAt        : Timestamp;
}

entity POData {

    key PONumber            : String(20);

    LineNumber              : String(10);

    PurReqNumber            : String(20);
    PurReqItemNo            : String(10);

    Vendor                  : String(20);
    VendorName              : String(255);

    Plant                   : String(10);

    POQty                   : String(20);
    PRQty                   : String(20);

    GRNQty                  : String(20);

    GRNStatus               : String(50);

    POVendorConfStatus      : String(50);

    CreatedBy               : String(20);

    PODelDate               : String(20);
    GRNDate                 : String(20);

    CreatedAt               : Timestamp;
}