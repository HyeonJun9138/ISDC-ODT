from copy import deepcopy

COMMUNICATION = {
    "nodes": [
        {"id": "SAT-01", "type": "satellite", "status": "online", "x": 50, "y": 14},
        {"id": "SAT-02", "type": "satellite", "status": "online", "x": 20, "y": 30},
        {"id": "SAT-03", "type": "satellite", "status": "warning", "x": 80, "y": 31},
        {"id": "SAT-04", "type": "satellite", "status": "online", "x": 50, "y": 47},
        {"id": "SAT-05", "type": "satellite", "status": "danger", "x": 26, "y": 59},
        {"id": "GS-01", "type": "ground", "status": "online", "x": 15, "y": 78},
        {"id": "GS-02", "type": "ground", "status": "online", "x": 50, "y": 80},
        {"id": "GS-03", "type": "ground", "status": "warning", "x": 84, "y": 78},
        {"id": "GW-OISL", "type": "gateway", "status": "online", "x": 34, "y": 94},
        {"id": "GW-DTN", "type": "gateway", "status": "online", "x": 67, "y": 94},
    ],
    "links": [
        {"id": "L01", "source": "SAT-01", "target": "SAT-02", "quality": 98, "protocol": "OISL"},
        {"id": "L02", "source": "SAT-01", "target": "SAT-03", "quality": 98, "protocol": "OISL"},
        {"id": "L03", "source": "SAT-01", "target": "SAT-04", "quality": 86, "protocol": "DTN"},
        {"id": "L04", "source": "SAT-02", "target": "SAT-05", "quality": 42, "protocol": "OISL"},
        {"id": "L05", "source": "SAT-03", "target": "GS-03", "quality": 66, "protocol": "OISL"},
        {"id": "L06", "source": "SAT-04", "target": "GS-02", "quality": 91, "protocol": "DTN"},
        {"id": "L07", "source": "SAT-05", "target": "GS-01", "quality": 91, "protocol": "DTN"},
        {"id": "L08", "source": "GS-02", "target": "GW-DTN", "quality": 96, "protocol": "DTN"},
        {"id": "L09", "source": "GS-01", "target": "GW-OISL", "quality": 94, "protocol": "OISL"},
        {"id": "L10", "source": "GW-OISL", "target": "GW-DTN", "quality": 99, "protocol": "Backbone"},
    ],
    "queue": [
        {"id": "PKT-7A3F", "route": "SAT-01 → SAT-04", "progress": 78, "size": "3.1 KB", "protocol": "OISL"},
        {"id": "PKT-981C", "route": "SAT-02 → GS-01", "progress": 55, "size": "2.0 KB", "protocol": "DTN"},
        {"id": "PKT-3D8E", "route": "GS-02 → GW-OISL", "progress": 92, "size": "4.0 KB", "protocol": "DTN"},
        {"id": "PKT-6F2A", "route": "SAT-03 → SAT-06", "progress": 33, "size": "6.0 KB", "protocol": "OISL"},
    ],
}

def communication():
    return deepcopy(COMMUNICATION)
