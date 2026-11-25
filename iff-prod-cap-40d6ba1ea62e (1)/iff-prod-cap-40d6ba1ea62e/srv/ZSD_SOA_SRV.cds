using ZSD_SOA_SRV from './external/ZSD_SOA_SRV.cds';

service ZSD_SOA_SRVSampleService {
    @readonly
    entity CreateSOs    as
        projection on ZSD_SOA_SRV.CreateSOs {
            key SalesOrder,
                DocumentNumber,
                DocumentDate,
                OrderType,
                SalesOrg,
                DistributionChan,
                Division,
                SenderId,
                ShipToId,
                ItemNumber,
                Description,
                CustomerMatNum,
                Quantity,
                UnitOfMeasure,
                NetAmount,
                UnitPrice,
                CurrencyCode,
                CRS
        };

    entity SalesOrders  as
        projection on ZSD_SOA_SRV.SalesOrders {
            key PurchaseOrder,
                SalesOrderNum,
                TaxId,
                NetAmount,
                GrossAmount,
                CurrencyCode,
                DocumentDate,
                DeliveryDate,
                PaymentTerms,
                SenderBankAccount,
                SenderAddress,
                SenderName,
                ShipToAddress,
                TaxIdNumber,
                ReceiverId,
                ShippingTerms,
                Quantity,
                SenderId,
                SenderStreet,
                SenderCity,
                SenderHouseNumber,
                SenderPostalCode,
                SenderCountryCode,
                SenderPhone,
                SenderFax,
                SenderEmail,
                SenderState,
                SenderDistrict,
                SenderExtAddresPart,
                ShipToName,
                ShipToStreet,
                ShipToCity,
                ShipToHouseNumber,
                ShipToPostalCode,
                ShipToCountryCode,
                ShipToPhone,
                ShipToFax,
                ShipToEmail,
                ShipToState,
                ShipToDistrict,
                ShipToExtraAddressPart,
                ShipToId,
                Internal,
                FlagIdentify,
                HeaderStatus,
                Nav_HeaderStat,
                Nav_ItemStat,
                Nav_LineItem,
                Nav_ShipTo,
                Nav_SoldTo

        };

    @readonly
    entity SalesDatas   as
        projection on ZSD_SOA_SRV.SalesDatas {
            key SalesOrg,
            key OrderType,
                CSR,
                ErrorMesg,
                ManualSec
        };

    @readonly
    entity SimulateSOs  as
        projection on ZSD_SOA_SRV.SimulateSOs {
            key DocumentNumber,
                DocumentDate,
                OrderType,
                SalesOrg,
                DistributionChan,
                Division,
                SenderId,
                ShipToId,
            key ItemNumber,
                Description,
                CustomerMatNum,
                Quantity,
                UnitOfMeasure,
                NetAmount,
                UnitPrice,
                CurrencyCode,
                CSR
        };

    @readonly
    entity SoldTos      as
        projection on ZSD_SOA_SRV.SoldTos {
            key SoldToId,
                SoldToName,
                SoldToAddress
        };

    @readonly
    entity ShipTos      as
        projection on ZSD_SOA_SRV.ShipTos {
            key ShipToId,
                ShipToName,
                ShipToAddress
        };

    @readonly
    entity SearchHelps  as
        projection on ZSD_SOA_SRV.SearchHelps {
                Country,
                Name1,
                Name2,
                PostalCode,
                StreetHouseNo,
                MatchCode1,
                MatchCode2,
                CityCode,
                City,
            key CustomerNo
        };

    @readonly
    entity Returns      as
        projection on ZSD_SOA_SRV.Returns {
            key Type,
                Id,
                Number,
                Message
        };

    @readonly
    entity Lineitems    as
        projection on ZSD_SOA_SRV.Lineitems {
            key DocumentNumber,
            key ItemNumber,
                Material,
                Description,
                NetAmount,
                Quantity,
                UnitPrice,
                DocumentDate,
                CurrencyCode,
                SupplierMatNum,
                CustomerMatNum,
                UnitOfMeasure,
                ItemStatus
        };

    @readonly
    entity ItemStats    as
        projection on ZSD_SOA_SRV.ItemStats {
            key ItemNumber,
                MaterialNo,
                Description,
                Quantity,
                UOM
        };

    @readonly
    entity HeaderStats  as
        projection on ZSD_SOA_SRV.HeaderStats {
            key PurchaseNo,
                PODate,
                SalesOrg,
                OrderType,
                SoldTo,
                SoldToName,
                ShipTo,
                ShipToName
        };

    @readonly
    entity DetKeyValues as
        projection on ZSD_SOA_SRV.DetKeyValues {
            key PurchaseOrder,
                PoDate,
                SoldToId,
                ShipToId,
                Material,
                Quantity,
                UnitOfMeasure
        };
}
