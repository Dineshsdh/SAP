sap.ui.define([
    "sap/ui/core/UIComponent"
], function (UIComponent) {
    "use strict";

    return UIComponent.extend("prpoautomation.Component", {

        metadata: {
            manifest: "json"
        },

        init: function () {

            UIComponent.prototype.init.apply(this, arguments);

            var oRouter = this.getRouter();

            if (oRouter) {
                oRouter.initialize();
            }
        }
    });
});