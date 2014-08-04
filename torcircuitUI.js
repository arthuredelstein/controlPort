
// nodeDataForID(controller, id, onResult)__.
// Requests the IP, country code, and name of a node with given ID.
// Returns result via onResult.
// Example: nodeData(["20BC91DC525C3DC9974B29FBEAB51230DE024C44"], show);
let nodeDataForID = function (controller, ids, onResult) {
  let idRequests = ids.map(function (id) { return "ns/id/" + id; });
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
};

////////// popup

let nodeLines = function (nodeData) {
  let result = ["This browser"];
  for (let {ip, county} of nodeData) {
    result.push(ip + " (" + country + ")");
  }
  result.push("Internet");
  return result;
};

let updateCircuitDisplay = function () {
  let URI = gBrowser.selectedBrowser.currentURI,
      domain = null,
      nodeData = null;
      // Try to get a domain for this URI. Otherwise it remains null.
      try {
        domain = URI.host;
      } catch (e) { }
  if (domain) {
	// Update the displayed domain.
	document.querySelector("svg#tor-circuit text#domain").innerHTML = "(" + domain + "):";
	// Update the display information for the relay nodes.
	if (nodeData) {
      let diagramNodes = document.querySelectorAll("svg#tor-circuit text.node"),
      lines = nodeLines(nodeData);       
      for (let i = 0; i < diagramNodes.length; ++i) {
        diagramNodes[i].innerHTML = lines[i];
      }
    }
  }
  // Only show the Tor circuit if we have a domain.
  document.querySelector("svg#tor-circuit").style.display = domain ? 'block' : 'none';
};

let syncDisplayWithSelectedTab = function () {
  // Whenever a different tab is selected, change the circuit display
  // to show the circuit for that tab's domain.
  gBrowser.tabContainer.addEventListener("TabSelect", function (event) {
    updateCircuitDisplay();
  });
  // If the currently selected tab has been sent to a new location,
  // update the circuit to reflect that.
  gBrowser.addTabsProgressListener({ onLocationChange : function (aBrowser) {
    if (aBrowser == gBrowser.selectedBrowser) {
      updateCircuitDisplay();
    }
  } });
  updateCircuitDisplay();
};
