const sendPaged = (res, result) => {
  res.json({
    success: true,
    data: {
      items: result.items,
      summary: result.summary,
      range: result.range,
    },
    pageInfo: result.pageInfo,
  });
};

module.exports = { sendPaged };
