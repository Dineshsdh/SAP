"use strict";
 
function validatePR(PRNumber, PRItem) {
 
    if (!PRNumber) {
        return {
            valid: false,
            message: "PR Number is required."
        };
    }
 
    if (!PRItem) {
        return {
            valid: false,
            message: "PR Item is required."
        };
    }
 
    return {
        valid: true,
        message: "Valid PR"
    };
}
 
 
module.exports = {
    validatePR
};
 