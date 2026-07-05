const roundMoney = (value) => Math.round((value || 0) * 100) / 100;

module.exports = { roundMoney };
