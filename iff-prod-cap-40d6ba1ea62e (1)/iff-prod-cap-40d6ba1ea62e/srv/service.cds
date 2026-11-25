using {soautomation as db} from '../db/schema';

type WorkflowContext {
  attachmentid     : String;
  body             : LargeString;
  bodypreview      : String;
  ccrecipients     : String;
  fileName         : String @title: 'File Name';
  receiveddatetime : Timestamp;
  subject          : String;
  to               : String;
  ![from]          : String;
}

type SimulateOrderItem {
  DocumentNumber : String;
  ItemNumber     : String;
  Material       : String;
  Description    : String;
  NetAmount      : String;
  Quantity       : String;
  UnitPrice      : String;
  DocumentDate   : String;
  ReqDate        : String;
  DeliveryDate   : String;
  MSDate         : String;
  CurrencyCode   : String;
  SupplierMatNum : String;
  CustomerMatNum : String;
  Kdmat          : String;
  UnitOfMeasure  : String;
  Plant          : String;
  ItemCategory   : String;
  Route          : String;
  ManualLineItem : String;
  Kdkgl          : String(100);
  Kdkg1          : String(100);

}

type SimulateOrderReturn {}

type SimulateOrderNavEntry {
  Text : String;
}
type SimuAddPriceCondEntry {
  ItemNumber : String;
  CondType   : String;
  CondValue  : String;
  Currency   : String;
}

type SimuCreateTextEntry {
  ItemNumber: String;
  TextId: String;
  Langu: String;
  TextLine: String
}

type CreateOrderItem {
  DocumentNumber : String;
  ItemNumber     : String;
  Material       : String;
  Description    : String;
  NetAmount      : String;
  Quantity       : String;
  UnitPrice      : String;
  DocumentDate   : String;
  CurrencyCode   : String;
  SupplierMatNum : String;
  CustomerMatNum : String;
  UnitOfMeasure  : String;
  ID             : String;
  DeliveryDate   : String;
  ReqDate        : String;
  MSDate         : String;
  Plant          : String;
  Route          : String;
  ItemCategory   : String;
  Kdmat          : String;
  ManualLineItem : String;
  Kdkgl          : String(100);
  Kdkg1          : String(100);
}

type CreateOrderReturn {}

type TemplateResult {
  customer   : String;
  system     : String;
  schemaName : String;
  version    : Integer;
  template   : Boolean;
  ruleId     : UUID;
  domain     : String;
}

type GetDoxExtractedFieldsResult {
  message       : String;
  status        : String;
  hasExtraction : Boolean;
  logId         : Integer;
  logsId        : many Integer;
}

type CreateAddPriceCond {
  ItemNumber : String;
  CondType   : String;
  CondValue  : String;
  Currency   : String;
}

type CreateText {
  ItemNumber : String;
  TextId     : String;
  Langu      : String;
  TextLine   : String;
}

type ItemStatEntry {}
type HeaderStatEntry {}

type DocumentHeaderUpdateInput {
  ID                         : UUID;
  documentNumber             : String(100);
  taxId                      : String(50);
  dtmCSR                     : String(100);
  dtmUoM                     : String(50);
  internal                   : String(100);
  quantity                   : Decimal(15, 2);
  senderId                   : String(100);
  shipToId                   : String(100);
  netAmount                  : Decimal(15, 2);
  senderFax                  : String(50);
  shipToFax                  : String(50);
  receiverId                 : String(100);
  senderCity                 : String(255);
  senderName                 : String(255);
  shipToCity                 : String(255);
  shipToName                 : String(255);
  dtmSalesOrg                : String(50);
  dtmOrderType               : String(50);
  grossAmount                : Decimal(15, 2);
  senderEmail                : String(255);
  senderPhone                : String(50);
  senderState                : String(100);
  shipToEmail                : String(255);
  shipToPhone                : String(50);
  shipToState                : String(255);
  taxIdNumber                : String(50);
  currencyCode               : String(10);
  deliveryDate               : Date;
  documentDate               : Date;
  customerRefDate            : Date;
  sentDate                   : Date;
  priceDate                  : Date;
  paymentTerms               : String(255);
  senderStreet               : String(255);
  shipToStreet               : String(255);
  senderAddress              : String(500);
  shipToAddress              : String(500);
  shippingTerms              : String(255);
  senderDistrict             : String(100);
  shipToDistrict             : String(100);
  senderPostalCode           : String(50);
  shipToPostalCode           : String(50);
  senderBankAccount          : String(100);
  senderCountryCode          : String(10);
  senderHouseNumber          : String(50);
  shipToCountryCode          : String(10);
  shipToHouseNumber          : String(50);
  senderExtraAddressPart     : String(255);
  shipToExtraAddressPart     : String(255);
  salesGroup                 : String(100);
  salesGroupDescription      : String(255);
  priceGroup                 : String(100);
  priceGroupDescription      : String(255);
  dtmDivision                : String(50);
  deliveryTerm               : String(255);
  senderPoBox                : String(250);
  shipToPoBox                : String(250);
  extractedSenderCountryCode : String(150);
  vendorCountryCode          : String(100);
  billToId                   : String(100);
  payerId                    : String(100);
}

type DocumentLineItemUpdateInput {
  ID                     : UUID;
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
  SAPUnitOfMeasure       : String(100);
  unitPrice              : Decimal(15, 3);
  netAmount              : Decimal(15, 2);
  unitOfMeasure          : String(10);
  currencyCode           : String(10);
  documentDate           : Date;
  SalesOrder             : String(100);
  IncoTerm1              : String(255);
  IncoTerm2              : String(255);
  SAPItemNetValue        : Decimal(15, 3);
  documentNumber         : String;
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
  Kdkgl                  : String(100);
  Kdkg1                  : String(100);
  Kdmat                  : String(100);
  Postx                  : String(255);
}

type DocumentPriceUpdateInput {
  ID              : UUID;
  id              : UUID;
  itemNumber      : Integer;
  condType        : String(100);
  Vtext           : String(255);
  CondValue       : Decimal(15, 3);
  Currency        : String(50);
  CondUnit        : String(100);
  CondPricingUnit : Decimal(15, 3);
  CondPriceDate   : Date;
  manuallyAdded   : Boolean;
}

type DocumentTextUpdateInput {
  ID         : UUID;
  itemNumber : Integer;
  textName   : String(100);
  text       : String(5000);
  textId     : String(50);
  lang       : String(50);
  manuallyAdded : Boolean;
}

type DocumentSoldToOptionUpdateInput {
  ID            : UUID;
  soldToId      : String(100);
  soldToName    : String(255);
  soldToAddress : String(500);
  isSelected    : Boolean;
}

type DocumentShipToOptionUpdateInput {
  ID            : UUID;
  shipToId      : String(100);
  shipToName    : String(255);
  shipToAddress : String(500);
  isSelected    : Boolean;
}

type DocumentMaterialOptionUpdateInput {
  ID                  : UUID;
  materialNo          : String(100);
  materialDescription : String(255);
  isSelected          : Boolean;
}

type DocumentHeaderStatUpdateInput {
  ID                  : UUID;
  purchaseOrderNumber : String(100);
  purchaseOrderDate   : Date;
  orderType           : String(50);
  salesOrg            : String(50);
  shipToName          : String(255);
  shipToId            : String(100);
  shipToAddress       : String(255);
  soldToName          : String(255);
  soldToId            : String(100);
  soldToAddress       : String(255);
  SAPNetVal           : Decimal(15, 3);
  SAPCurrencyCode     : String(10);
  TermsOfPaymentDesc  : String(500);
  TermsOfPayment      : String(50);
  payerId             : String(100);
  payerName           : String(255);
  payerAddress        : String(500);
  billToId            : String(100);
  billToName          : String(255);
  billToAddress       : String(500);
  incoTerm1           : String(255);
  incoTerm1Desc       : String(255);
  incoTerm2           : String(255);
  incoTerm2Desc       : String(255);
}

type DocumentPartnerUpdateInput {
  ID     : UUID;
  APCode : String(50);
  APName : String(255);
  ZDCode : String(50);
  ZDName : String(255);
  ZFCode : String(50);
  ZFName : String(255);
  ZQCode : String(50);
  ZQName : String(255);
  ZRCode : String(50);
  ZRName : String(255);
  ZSCode : String(50);
  ZSName : String(255);
}

type DocumentPackProposalUpdateInput {
  ID                   : UUID;
  ProposalType         : String(50);
  ItemNumber           : String(10);
  UnqKey               : String(200);
  HandlingUnit         : String(50);
  IPCMaterial          : String(18);
  PackMaterial         : String(18);
  PackMatDesc          : String(255);
  Quantity             : String(50);
  UnitOfMeasure        : String(10);
  PackInstruction      : String(100);
  NoOfHU               : String(10);
  SalesOrg             : String(10);
  DistChannel          : String(10);
  ShipToId             : String(100);
  RequestMaterial      : String(18);
  RequestPlant         : String(10);
  RequestQuantity      : String(50);
  RequestUnitOfMeasure : String(10);
}

type DocumentUpdateInput {
  ID                      : UUID;
  attachmentId            : String(100);
  instanceId              : String(255);
  ProcessingStatus        : String(100);
  SalesOrder              : String(100);
  status                  : String(100);
  subject                 : String(500);
  remark                  : String(500);
  customer                : String(100);
  fileName                : String(255);
  emailSender             : String(255);
  receivedDatetime        : Timestamp;
  statusDox               : String(100);
  schemaName              : String(100);
  schemaVersion           : Integer;
  trainModelAI            : Boolean;
  NetAmount               : String(50);
  DocumentHeaders         : array of DocumentHeaderUpdateInput;
  DocumentLineItems       : array of DocumentLineItemUpdateInput;
  DocumentPrices          : array of DocumentPriceUpdateInput;
  DocumentTexts           : array of DocumentTextUpdateInput;
  DocumentPartners        : array of DocumentPartnerUpdateInput;
  DocumentSoldToOptions   : array of DocumentSoldToOptionUpdateInput;
  DocumentShipToOptions   : array of DocumentShipToOptionUpdateInput;
  DocumentMaterialOptions : array of DocumentMaterialOptionUpdateInput;
  DocumentHeaderStats     : array of DocumentHeaderStatUpdateInput;
  DocumentPackProposal    : array of DocumentPackProposalUpdateInput;
}

type UpdateDocumentResult {
  documentId : UUID;
  message    : String;
}

type DocumentLineItemEntry {
  ID : UUID;
}

type DocumentEntry {
  ID                : UUID;
  DocumentLineItems : array of DocumentLineItemEntry;
}

type CancelDocumentItem {
  documentId   : UUID;
  cancelReason : String(500);
}

type HoldDocumentInput {
  documentId : UUID;
  logId      : Integer;
  comment    : String(500);
}

// Pack Proposal Body
type PackItem {
  ItemNumber    : String(6);
  Material      : String(18);
  Plant         : String(4);
  Quantity      : Decimal(13, 3);
  UnitOfMeasure : String(3);
}

type PackHUSummary {}
type PackPartialQty {}

// Parner Detail Nav
type PartnerDetail {}

// OData validate/determine for PR1
type ODataDeterminePR1LineItem {
  ID             : UUID;
  DocumentNumber : String(100);
  ItemNumber     : String(10);
  Description    : String(255);
  NetAmount      : String(50);
  Quantity       : String(50);
  UnitPrice      : String(50);
  DocumentDate   : String(50);
  CurrencyCode   : String(10);
  SupplierMatNum : String(100);
  CustomerMatNum : String(100);
  UnitOfMeasure  : String(10);
}

type ODataDeterminePR1NavEntry {}

type ODataDeterminePR1Input {
  documentId             : UUID;
  ID                     : UUID;
  reExtractData          : Boolean;
  PurchaseOrder          : String(100);
  TaxId                  : String(50);
  NetAmount              : String(50);
  GrossAmount            : String(50);
  CurrencyCode           : String(10);
  DocumentDate           : String(50);
  DeliveryDate           : String(50);
  PaymentTerms           : String(255);
  SenderBankAccount      : String(100);
  SenderAddress          : String(500);
  SenderName             : String(255);
  ShipToAddress          : String(500);
  TaxIdNumber            : String(50);
  ReceiverId             : String(100);
  ShippingTerms          : String(255);
  Quantity               : String(50);
  SalesOrg               : String(50);
  SenderId               : String(100);
  SenderStreet           : String(255);
  SenderCity             : String(255);
  SenderHouseNumber      : String(50);
  SenderPostalCode       : String(50);
  SenderCountryCode      : String(10);
  SenderPhone            : String(50);
  SenderFax              : String(50);
  SenderEmail            : String(255);
  SenderState            : String(100);
  SenderDistrict         : String(100);
  SenderExtAddressPart   : String(255);
  ShipToName             : String(255);
  ShipToStreet           : String(255);
  ShipToCity             : String(255);
  ShipToHouseNumber      : String(50);
  ShipToPostalCode       : String(50);
  ShipToCountryCode      : String(10);
  ShipToPhone            : String(50);
  ShipToFax              : String(50);
  ShipToEmail            : String(255);
  ShipToState            : String(255);
  ShipToDistrict         : String(255);
  ShipToExtraAddressPart : String(255);
  ShipToId               : String(100);
  Internal               : String(100);
  Nav_LineItem           : array of ODataDeterminePR1LineItem;
  Nav_BillTo             : array of ODataDeterminePR1NavEntry;
  Nav_HeaderStat         : array of ODataDeterminePR1NavEntry;
  Nav_ItemStat           : array of ODataDeterminePR1NavEntry;
  Nav_Material           : array of ODataDeterminePR1NavEntry;
  Nav_OrderType          : array of ODataDeterminePR1NavEntry;
  Nav_Payer              : array of ODataDeterminePR1NavEntry;
  Nav_SalesOrg           : array of ODataDeterminePR1NavEntry;
  Nav_ShipTo             : array of ODataDeterminePR1NavEntry;
  Nav_SoldTo             : array of ODataDeterminePR1NavEntry;
  Nav_Return             : array of ODataDeterminePR1NavEntry;
}


service SalesAutomationService {
  entity SalesOrgs               as projection on db.SalesOrgs;
  entity CustomerConfig          as projection on db.CustomerConfig;
  entity CustomerConfigRule      as projection on db.CustomerConfigRule;
  entity EmailMapping            as projection on db.EmailMapping;
  entity RoleEmailMapping        as projection on db.RoleEmailMapping;
  entity Documents               as projection on db.Documents;
  entity DocumentHeaders         as projection on db.DocumentHeaders;
  entity DocumentLineItems       as projection on db.DocumentLineItems;
  entity DocumentPrices          as projection on db.DocumentPrices;
  entity DocumentTexts           as projection on db.DocumentTexts;
  entity DocumentPartners        as projection on db.DocumentPartners;
  entity DocumentSoldToOptions   as projection on db.DocumentSoldToOptions;
  entity DocumentShipToOptions   as projection on db.DocumentShipToOptions;
  entity DocumentMaterialOptions as projection on db.DocumentMaterialOptions;
  entity DocumentHeaderStats     as projection on db.DocumentHeaderStats;
  entity DocumentSalesOrgs       as projection on db.DocumentSalesOrgs;
  entity DocumentFieldHistories  as projection on db.DocumentFieldHistories;
  entity DocumentCCRecipients    as projection on db.DocumentCCRecipients;
  entity DocumentAttachments     as projection on db.DocumentAttachments;
  entity DocumentPackProposal    as projection on db.DocumentPackProposal;
  entity UserVariants            as projection on db.UserVariants;

  action   determineTemplate(definitionId: String,
                             context: WorkflowContext)                   returns TemplateResult;

  action   getDoxExtractedFields(attachmentId: String,
                                 instanceId: String,
                                 skipUpsert: Boolean,
                                 reExtractionFromODataDeterminePR1: Boolean,
                                 emailSender: String(255),
                                 receivedDatetime: String(255),
                                 subject: String(500),
                                 schemaName: String(100),
                                 schemaVersion: String(100),
                                 emailFrom: String(255),
                                 ccRecipients: String(1000),
                                 fileName: String(500),
                                 customer: String(150),
                                 ruleId: String(150),
                                 domain: String(255))                    returns GetDoxExtractedFieldsResult;

  action   formatExtractedFields(body: LargeString)                      returns LargeString;
  action   determineCustomer(body: LargeString)                          returns array of String;
  action   upsertDocument(body: LargeString)                             returns LargeString;
  action   oDataDetermine(body: LargeString)                             returns LargeString;
  action   getDetermineResult(filter: String,
                              expand: String,
                              attachmentId: String,
                              instanceId: String,
                              logId: String,
                              persistResults: Boolean)                             returns LargeString;                
  action   getSimulateResult(filter: String,
                             expand: String,
                             attachmentId: String,
                             instanceId: String,
                             logId: String,
                             persistResults: Boolean)                              returns LargeString;
  action   getCreationResult(taskId: array of String,
                             individualCreation: Boolean,
                             expand: String,
                             filter: String,
                             attachmentId: String,
                             instanceId: String,
                             logId: String,
                             ID: String,
                             system: String)                                       returns LargeString;
  action   oDataDeterminePR1(data: ODataDeterminePR1Input)               returns LargeString;
  action   updateDocument(data: DocumentUpdateInput)                     returns UpdateDocumentResult;
  action   CancelDocuments(documents: array of CancelDocumentItem)       returns Integer;
  action   holdDocuments(data: HoldDocumentInput)                        returns Integer;

  action   deleteDocuments(LogsId: array of Integer,
                           InboxEmail: String(255))                      returns Integer;

  action   unlockDocuments(LogsId: array of Integer,
                           InboxEmail: String(255),
                           Status: String(100),
                           LineItems: array of Integer,
                           SalesOrder: String(100),
                           UserId: String(255))                          returns Integer;

  action   oDataSimulateOS(ID: String,
                           DocumentNumber: String,
                           DocumentDate: String,
                           PriceDate: String,
                           DeliveryDate: String,
                           ReqDate: String,
                           OrderType: String,
                           SalesOrg: String,
                           DistributionChan: String,
                           Division: String,
                           SenderId: String,
                           ShipToId: String,
                           ShipToAddress: String,
                           SendingEmail: String,
                           EmailBox: String,
                           IncoTerm1: String,
                           IncoTerm2: String,
                           PriceGroup: String,
                           SalesGroup: String,
                           CurrencyCode: String,
                           Nav_SimItem: array of SimulateOrderItem,
                           Nav_SimReturn: array of SimulateOrderReturn,
                           Nav_PriceSim: array of SimulateOrderNavEntry,
                           Nav_SimText: array of SimulateOrderNavEntry,
                           Nav_SimuAddPriceCond: array of SimuAddPriceCondEntry,
                           Nav_SimuCreateText: array of SimuCreateTextEntry,
                           Nav_ItemStat: array of ItemStatEntry,
                           Nav_HeaderStat: array of HeaderStatEntry,
                           attachmentId: String,
                           instanceId: String,
                           logId: String)                                returns LargeString;

  action   oDataCreateSOs(ID: String,
                          SalesOrder: String,
                          DocumentNumber: String,
                          DocumentDate: String,
                          DeliveryDate: String,
                          OrderType: String,
                          SalesOrg: String,
                          DistributionChan: String,
                          Division: String,
                          SenderId: String,
                          ShipToId: String,
                          SalesGroup: String,
                          PriceGroup: String,
                          IncoTerm1: String,
                          IncoTerm2: String,
                          CurrencyCode: String,
                          ShipToAddress: String,
                          SendingEmail: String,
                          EmailBox: String,
                          individualCreation: Boolean,
                          ReqDate: String,
                          PriceDate: String,
                          Dlv_Block: String,
                          BillToId: String,
                          PayerId: String,
                          ContactPersonId: String,
                          ContactPersonId_Inv: String,
                          ContactPersonId_CoA: String,
                          ContactPersonId_MSDS: String,
                          ContactPersonId_Dino: String,
                          SalesRepresentativeId: String,
                          // trainModelAI: Boolean,
                          Nav_Item: array of CreateOrderItem,
                          Nav_Return: array of CreateOrderReturn,
                          Nav_CreAddPriceCond: array of CreateAddPriceCond,
                          Nav_CreateText: array of CreateText,
                          Nav_ItemStat: array of ItemStatEntry,
                          Nav_HeaderStat: array of HeaderStatEntry,
                          attachmentId: String,
                          instanceId: String)                            returns LargeString;

  action   deleteDocumentLineItems(data: DocumentEntry)                  returns UpdateDocumentResult;
  action   splitDocument(data: DocumentEntry)                            returns UpdateDocumentResult;

  action   resetLogId(attachmentId: String(100),
                      logId: Integer,
                      documentId: UUID,
                      instanceId: String(255))                           returns Integer;

  action   blockDocuments(logId: Integer,
                      attachmentId: String(100),
                      instanceId: String(255))                           returns Integer;

  function getUserInfo()                                                 returns {
    email      : String(500);
    userId     : String(255);
    familyName : String(255);
    givenName  : String(255);
    roles      : array of String;
  };

  function getDoxBaseUrl()                                               returns {
    environment : String(50);
    baseUrl     : String(255);
  };

  action   postPackProposal(SalesOrg: String,
                            DistChannel: String,
                            ShipToId: String,
                            Nav_PackItem: array of PackItem,
                            Nav_PackHUSummary: array of PackHUSummary,
                            Nav_PackPartialQTy: array of PackPartialQty) returns LargeString;

  action   postTrainingRequest(FromEmail: String,
                               ToEmail: String,
                               LogId: String,
                               MailBody: String,
                               FileName: String,
                               FileId: String)                           returns LargeString;

  action   postPartnerDetails(SalesOrg: String,
                              DistChannel: String,
                              Division: String,
                              SoldToId: String,
                              ShipToId: String,
                              Nav_PartnerDetail: array of PartnerDetail) returns LargeString;
}
