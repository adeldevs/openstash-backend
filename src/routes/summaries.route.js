const express = require('express');

const { listSummaries, getSummaryById } = require('../controllers/summaries.controller');

const router = express.Router();

router.get('/', listSummaries);
router.get('/:id', getSummaryById);

module.exports = router;
