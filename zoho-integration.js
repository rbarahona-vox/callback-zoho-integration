const express = require('express');
const app = express();
app.use(express.json());

app.post('/', (req, res) => {

  //HERE YOU GET AND LOG MANUAL CALL INFO
console.log(req.body.callbacks[0].new_calls);
res.sendStatus(200);
});

app.get('/', (req, res) => {
 res.sendStatus(200);
});

app.listen(3000);
console.log("server started on 3000");
