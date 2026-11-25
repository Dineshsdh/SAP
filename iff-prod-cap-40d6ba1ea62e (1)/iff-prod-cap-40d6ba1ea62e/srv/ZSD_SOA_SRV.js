
const { mapDoxToECC } = require('./utils.js')

const cds = require('@sap/cds');


module.exports = cds.service.impl(async function () {
  const ZSD_SOA_SRV = await cds.connect.to("ZSD_SOA_SRV");

  // this.on('READ', '*', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'CreateSOs', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'SalesOrders', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'SalesDatas', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'SimulateSOs', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'SoldTos', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'ShipTos', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'SearchHelps', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'Returns', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'Lineitems', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'ItemStats', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'HeaderStats', req => ZSD_SOA_SRV.run(req.query));
  this.on('READ', 'DetKeyValues', req => ZSD_SOA_SRV.run(req.query));

  this.on('CREATE', 'SalesOrders', async (req) => {
    try {
      const rawData = req.data;
      const data = mapDoxToECC(rawData)
      const result = await ZSD_SOA_SRV.tx(req).post('/SalesOrders', data);
      return result;
    } catch (error) {
      req.error(500, error.message || "Error desconocido al crear SalesOrders");
    }
  });
});
