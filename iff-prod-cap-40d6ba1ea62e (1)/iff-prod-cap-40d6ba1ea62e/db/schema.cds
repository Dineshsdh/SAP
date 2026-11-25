namespace soautomation;

using {managed} from '@sap/cds/common';

entity SalesOrgs : managed {
  key SalesOrg  : Integer;
      Automated : Boolean;
}

entity CustomerConfig : managed {
  key customer   : String(255) @title: 'Customer Email or ID';
      schemaName : String(255) @title: 'Schema Name';
      version    : Integer     @title: 'Schema Version';
      template   : Boolean     @title: 'Uses Template?';
      rules      : Composition of many CustomerConfigRule
                     on rules.customer = $self;
}

entity CustomerConfigRule : managed {
  key ID               : UUID;
      customer         : Association to CustomerConfig;
      schemaName       : String(255) @title: 'Schema Name';
      version          : Integer     @title: 'Schema Version';
      template         : Boolean     @title: 'Uses Template?';
      subjectKeywords  : String(500) @title: 'Keywords for subject (; separated)';
      bodyKeywords     : String(500) @title: 'Keywords for body (; separated)';
      fileNameKeywords : String(500) @title: 'Keywords for file name (; separated)';
      priority         : Integer default 100 @title: 'Rule priority (lower wins)';
      active           : Boolean default true @title: 'Rule active';
      logic            : String(250) @title: 'Customer Rule to be applied';
}

entity EmailMapping : managed {
  key ID     : UUID;
      email  : String(255);
      system : String(10);
}

entity RoleEmailMapping : managed {
  key ID    : UUID;
      role  : String(50)  @title: 'Functional Role';
      email : String(255) @title: 'Sender Email';
}

@assert.unique: { logId: [LogId] }
entity Documents : managed {
  key ID                    : UUID;
      LogId                 : Integer;
      attachmentId          : String(100);
      training              : String(5);
      emailSender           : String(255);
      emailFrom             : String(255);
      system                : String(255);
      receivedDatetime      : Timestamp;
      fileName              : String(255);
      subject               : String(500);
      remark                : String(500);
      remarkUpdatedBy       : String(255);
      remarkUpdatedOn       : Timestamp;
      status                : String(100);
      deleted               : Boolean default false;
      cancelReason          : String(500);
      holdReason            : String(500);
      statusDox             : String(100);
      instanceId            : String(255);
      customer              : String(100);
      schemaName            : String(100);
      schemaVersion         : Integer;
      splitParentLogId      : Integer;
      splitIsParent         : Boolean default false;
      creationType          : String(50);
      taskId                : String(255);
      taskStatus            : String(255);
      completedAt           : Timestamp;
      completedBy           : String(255);
      DocumentHeaders       : Association to many DocumentHeaders
                                on DocumentHeaders.documentID = $self;
      DocumentLineItems     : Association to many DocumentLineItems
                                on DocumentLineItems.documentID = $self;
      DocumentPrices        : Association to many DocumentPrices
                                on DocumentPrices.documentID = $self;
      DocumentTexts         : Association to many DocumentTexts
                                on DocumentTexts.documentID = $self;
      DocumentPartners        : Association to many DocumentPartners
                                on DocumentPartners.documentID = $self;
      DocumentSoldToOptions : Association to many DocumentSoldToOptions
                                on DocumentSoldToOptions.documentID = $self;
      DocumentShipToOptions : Association to many DocumentShipToOptions
                                on DocumentShipToOptions.documentID = $self;
      DocumentMaterialOptions : Association to many DocumentMaterialOptions
                                on DocumentMaterialOptions.documentID = $self;
      DocumentHeaderStats   : Association to many DocumentHeaderStats
                                on DocumentHeaderStats.documentID = $self;
      DocumentSalesOrgs     : Association to many DocumentSalesOrgs
                                on DocumentSalesOrgs.documentID = $self;
      DocumentErrorLogs     : Association to many DocumentErrorLogs
                                on DocumentErrorLogs.documentID = $self;
      DocumentFieldHistories     : Association to many DocumentFieldHistories
                                on DocumentFieldHistories.documentID = $self;
      DocumentCCRecipients          : Association to many DocumentCCRecipients
                                on DocumentCCRecipients.documentID = $self;
      DocumentAttachments       : Association to many DocumentAttachments
                                on DocumentAttachments.documentID = $self;
      DocumentPackProposal      : Association to many DocumentPackProposal
                                on DocumentPackProposal.documentID = $self;
  }

entity DocumentHeaders : managed {
  key ID                     : UUID;
      LogId                  : Integer;
      documentID             : Association to one Documents;
      documentNumber         : String(100);
      netAmount              : Decimal(15, 2);
      currencyCode           : String(10);
      documentDate           : Date;
      customerRefDate        : Date;
      sentDate               : Date;
      deliveryDate           : Date;
      priceDate               :Date;
      paymentTerms           : String(255);
      grossAmount            : Decimal(15, 2);
      receiverId             : String(100);
      quantity               : Decimal(15, 2);
      senderAddress          : String(500);
      senderBankAccount      : String(100);
      senderId               : String(100);
      senderName             : String(255);
      shipToAddress          : String(500);
      shipToCity             : String(255);
      shipToCountryCode      : String(50);
      shipToEmail            : String(255);
      shipToExtraAddressPart : String(255);
      shipToName             : String(255);
      shipToPostalCode       : String(50);
      shipToState            : String(255);
      shipToStreet           : String(255);
      shippingTerms          : String(255);
      taxId                  : String(50);
      taxIdNumber            : String(50);
      senderStreet           : String(255);
      senderCity             : String(255);
      senderHouseNumber      : String(50);
      senderPostalCode       : String(50);
      senderCountryCode      : String(50);
      senderPhone            : String(50);
      senderFax              : String(50);
      senderEmail            : String(255);
      senderState            : String(100);
      senderDistrict         : String(100);
      senderExtraAddressPart : String(255);
      shipToHouseNumber      : String(50);
      shipToPhone            : String(50);
      shipToFax              : String(50);
      shipToDistrict         : String(100);
      shipToId               : String(100);
      internal               : String(100);
      dtmCSR                 : String(100);
      dtmUoM                 : String(50);
      dtmSalesOrg            : String(50);
      dtmOrderType           : String(50);
      dtmDivision            : String(50);
      salesGroup             : String(100);
      salesGroupDescription  : String(255);
      priceGroup             : String(100);
      priceGroupDescription  : String(255);
      deliveryTerm           : String(255);
      senderPoBox            : String(250);
      shipToPoBox            : String(250);
      extractedSenderCountryCode : String(150);
      vendorCountryCode      : String(100);
}

entity DocumentLineItems : managed {
  key ID                     : UUID;
      documentID             : Association to one Documents;
      itemNumber             : Integer;
      extractedItemNumber    : String(100);
      customerMaterialNumber : String(100);
      SAPMaterialNo          : String(100);
      SAPMaterialDescription : String(255);
      SAPCustMatNum          : String(100);
      SAPCustMatDesc         : String(255);
      SAPUnitPrice           : Decimal(15, 3);
      supplierMaterialNumber : String(100);
      description            : String(255);
      quantity               : Decimal(15, 3);
      SAPQuantity            : Decimal(15, 3);
      unitPrice              : Decimal(15, 3);
      netAmount              : Decimal(15, 2);
      unitOfMeasure          : String(10);
      SAPUnitOfMeasure       : String(100);
      currencyCode           : String(10);
      documentDate           : Date;
      SalesOrder             : String(100);
      incoTerm1              : String(255);
      incoTerm2              : String(255);
      documentNumber         : String(100);
      SAPItemNetValue        : Decimal(15, 3);
      deleted                : Boolean;
      shippingType           : String(255);
      GIDate                 : Date;
      LoadDate               : Date;
      MSDate                 : Date;
      TPDate                 : Date;
      ItemCategory           : String(100);
      Plant                  : String(50);
      Route                  : String(100);
      ConfDelDate            : Date;
      CondGrp1               : String(255);
      PackAvl                : String(100);
      orderCreatedBy         : String(255);
      manuallyAdded          : Boolean;
      Kmdat                  : String(255);
      Kdkgl                  : String(100);
      completedAt            : Timestamp;
      completedBy            : String(255);
}

entity DocumentPrices : managed {
  key ID               : UUID;
      documentID       : Association to one Documents;
      itemNumber       : Integer;
      condType         : String(100);
      Vtext            : String(255);
      CondValue        : Decimal(15, 3);
      Currency         : String(50);
      CondUnit         : String(100);
      CondPricingUnit  : Decimal(15, 3);
      CondPriceDate    : Date;
      manuallyAdded    : Boolean;
}

entity DocumentTexts : managed {
  key ID         : UUID;
      documentID : Association to one Documents;
      itemNumber : Integer;
      textName   : String(100);
      text       : String(5000);
      textId     : String(50);
      lang       : String(50);
      manuallyAdded : Boolean;
}

entity DocumentPartners : managed {
  key ID         : UUID;
      documentID : Association to one Documents;
      APCode     : String(50);
      APName     : String(255);
      ZDCode     : String(50);
      ZDName     : String(255);
      ZFCode     : String(50);
      ZFName     : String(255);
      ZQCode     : String(50);
      ZQName     : String(255);
      ZRCode     : String(50);
      ZRName     : String(255);
      ZSCode     : String(50);
      ZSName     : String(255);
}

entity DocumentSoldToOptions : managed {
  key ID            : UUID;
      documentID    : Association to one Documents;
      soldToId      : String(100);
      soldToName    : String(255);
      soldToAddress : String(500);
      isSelected    : Boolean default false;
}

entity DocumentShipToOptions : managed {
  key ID            : UUID;
      documentID    : Association to one Documents;
      shipToId      : String(100);
      shipToName    : String(255);
      shipToAddress : String(500);
      isSelected    : Boolean default false;
}

entity DocumentMaterialOptions : managed {
  key ID                 : UUID;
      documentID         : Association to one Documents;
      materialNo         : String(100);
      materialDescription : String(255);
      isSelected         : Boolean default false;
}

entity DocumentHeaderStats : managed {
  key ID                  : UUID;
      documentID          : Association to one Documents;
      purchaseOrderNumber : String(100);
      purchaseOrderDate   : Date;
      orderType           : String(50);
      salesOrg            : String(50);
      shipToName          : String(255);
      shipToId            : String(100);
      shipToAddress       : String(250);
      soldToName          : String(255);
      soldToId            : String(100);
      soldToAddress       : String(255);
      SAPNetVal           : Decimal(15, 3);
      SAPCurrencyCode     : String(10);
      TermsOfPaymentDesc  : String(500);
      TermsOfPayment      : String(50);
      payerId              : String(100);
      payerName            : String(255);
      payerAddress         : String(500);
      billToId             : String(100);
      billToName           : String(255);
      billToAddress        : String(500);
      incoTerm1            : String(255);
      incoTerm1Desc        : String(255);
      incoTerm2            : String(255);
      incoTerm2Desc        : String(255);
}

entity DocumentSalesOrgs : managed {
  key ID          : UUID;
      documentID  : Association to one Documents;
      Region      : String(50);
      SalesOrg    : String(50);
      Description : String(255);
      DisChannel  : String(50);
      Division    : String(50);
}

entity DocumentErrorLogs : managed {
  key ID         : UUID;
      documentID : Association to one Documents;
      type       : String(50);
      message    : String(255);
      number     : String(100);
      source     : String(255);

}

entity DocumentFieldHistories: managed {
  key ID            : UUID;
      documentID    : Association to one Documents;
      sourceEntity  : String(255);
      sourceRecordId: String(255);
      fieldName     : String(100);
      originalValue : LargeString;
      currentValue  : LargeString;
      userEmail :  String(500)
  };

entity DocumentCCRecipients : managed {
  key ID         : UUID;
      documentID : Association to one Documents;
      email      : String(255);
};

entity DocumentAttachments : managed {
  key ID                   : UUID;
      documentID           : Association to one Documents;
      attachmentId         : String(100);
      sharepointItemId     : String(255);
      driveId              : String(255);
      folderId             : String(255);
      name                 : String(500);
      webUrl               : String(1000);
      createdDateTime      : Timestamp;
      lastModifiedDateTime : Timestamp;
};

entity DocumentPackProposal : managed {
  key ID                   : UUID;
      documentID           : Association to one Documents;
      ProposalType         : String(50);
      ItemNumber           : String(10);
      UnqKey               : String(200);
      HandlingUnit         : String(50);
      IPCMaterial          : String(18);
      PackMaterial         : String(18);
      PackMatDesc          : String(255);
      Quantity             : Decimal(13, 3);
      UnitOfMeasure        : String(10);
      PackInstruction      : String(100);
      NoOfHU               : String(10);
      SalesOrg             : String(10);
      DistChannel          : String(10);
      ShipToId             : String(100);
      RequestMaterial      : String(18);
      RequestPlant         : String(10);
      RequestQuantity      : Decimal(13, 3);
      RequestUnitOfMeasure : String(10);
};
entity UserVariants: managed {
  Key ID : UUID;
      email: String(255);
      variantData: LargeString;
      appId: String(255);
      tableId: String(255);
}
