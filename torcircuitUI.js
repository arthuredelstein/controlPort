
// nodeDataForID(controller, id, onResult)__.
// Requests the IP, country code, and name of a node with given ID.
// Returns result via onResult.
// Example: nodeData(["20BC91DC525C3DC9974B29FBEAB51230DE024C44"], show);
var nodeDataForID = function (controller, ids, onResult) {
  var idRequests = ids.map(function (id) { return "ns/id/" + id; });
  controller.getInfoMultiple(idRequests, function (statusMap) {
    let status = statusMap.values;
    controller.getInfo("ip-to-country/" + status.IP, function (country) {
      onResult({ name : status.nickname, id : id , ip : status.IP , country : country });
    });
  });
};

// __circuits, domains__.
// Storage for all observed circuits and domains.
let circuits = {}, domainForCircuit = {}; circuitForDomain = {};

// __collectBuiltCircuitData(aController)__.
// Watches for CIRC BUILT events and records their data in the circuits map.
let collectBuiltCircuitData = function (aController) {
  aController.watchEvent("CIRC", function (data) { return data.status === "BUILT"; },
                         function (data) {
                           circuits[data.id] = data;
                         });
};

// __nodes__.
// Gets the information for a circuit.
let nodeDataForCircuit = function (controller, circuitData, onResult) {
  let ids = [];
  for (var i = 0; i < 3; ++i) {
    ids.push(circuitData.circuit[i][0]);
  }
  nodeDataForID(controller, ids, onResult);
};

// __assignCircuitsForDomains__.
// Watches STREAM events. Whenever a new circuit gets its first STREAM SENTCONNECT event,
// assign that circuit for that current domain.
let assignCircuitsForDomains = function (aController) {
  aController.watchEvent("STREAM",
                         function (data) { return data.StreamStatus === "SENTCONNECT"; },
                         function (data) {
                           let { Target, CircuitID } = data;
                           if (domainForCircuit[CircuitID] === undefined) {
                             domainForCircuit[CircuitID] = Target
                             circuitForDomain[Target] = circuits[CircuitID];
                           }
                         });
};

let collectDomainNodes = function (aController) {
  collectBuiltCircuitData(aController);
  assignCircuitsForDomains(aController);
};

////////// popup

let nodeLines = function (nodeData) {
  let result = ["This browser"];
  for (i in nodeData) {
    result.push(nodeData[i].ip + " (" + nodeData[i].country + ")");
  }
  result.push("Internet");
  return result;
};

let setCircuitDisplay = function (domain, nodeData) {
  // Update the displayed domain.
  document.querySelector("svg#tor-circuit text#domain").innerHTML = "(" + domain + "):";
  // Update the display information for the relay nodes.
  let diagramNodes = document.querySelectorAll("svg#tor-circuit text.node"),
      lines = nodeLines(nodeData);       
  for (let i = 0; i < diagramNodes.length; ++i) {
    diagramNodes[i].innerHTML = lines[i];
  }
};



