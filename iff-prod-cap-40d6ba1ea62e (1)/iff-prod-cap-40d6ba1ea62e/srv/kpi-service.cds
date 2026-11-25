service KPIService {
  action KPI_Orders_Detail(
    dateFrom      : String,
    dateTo        : String,
    location      : many String,
    region        : many String,
    bu            : many String,
    automationType: many String,
    Lines         : String,
    page          : Integer,
    pageSize      : Integer
  ) returns LargeString;

  action KPI_Orders(
    dateFrom      : String,
    dateTo        : String,
    kpiId         : Integer,
    location      : many String,
    region        : many String,
    bu            : many String,
    automationType: many String,
    Lines         : String,
    Average       : String
  ) returns LargeString;

  action KPI_Rejected(
    dateFrom : String,
    dateTo   : String,
    kpiId    : Integer,
    location : many String,
    region   : many String,
    bu       : many String
  ) returns LargeString;

  action KPI_Rate(
    dateFrom      : String,
    dateTo        : String,
    location      : many String,
    region        : String,
    bu            : many String,
    automationType: many String
  ) returns LargeString;

  action KPI_Rejected_Detail(
    dateFrom      : String,
    dateTo        : String,
    location      : many String,
    region        : many String,
    bu            : many String,
    reason        : many String,
    automationType: many String,
    Lines         : String,
    page          : Integer,
    pageSize      : Integer
  ) returns LargeString;
}
