from copy import deepcopy

HIL_DEVICES = [
    {"id": "VNX-SBC", "name": "VNX + SBC EM", "role": "연산/제어", "connected": True, "health": 98, "latency_ms": 8.2, "protocol": "gRPC", "mode": "MOCK", "channels": 24, "clock_offset_us": 12.4, "jitter_us": 2.1, "clock_state": "LOCKED"},
    {"id": "EDGE-AI", "name": "Edge AI EM", "role": "추론/판단", "connected": True, "health": 93, "latency_ms": 12.4, "protocol": "MQTT", "mode": "MOCK", "channels": 18, "clock_offset_us": 18.7, "jitter_us": 3.2, "clock_state": "LOCKED"},
    {"id": "OISL-EM", "name": "OISL EM", "role": "링크/전송", "connected": True, "health": 81, "latency_ms": 31.2, "protocol": "UDP", "mode": "MOCK", "channels": 32, "clock_offset_us": 38.5, "jitter_us": 7.8, "clock_state": "LOCKING"},
    {"id": "DTN-DFS", "name": "DTN / Space-DFS", "role": "라우팅/저장", "connected": True, "health": 88, "latency_ms": 18.7, "protocol": "TCP", "mode": "MOCK", "channels": 16, "clock_offset_us": 22.1, "jitter_us": 4.1, "clock_state": "LOCKED"},
    {"id": "PQC-TEE", "name": "PQC / TEE EM", "role": "보호전송/인증", "connected": True, "health": 99, "latency_ms": 6.8, "protocol": "mTLS", "mode": "MOCK", "channels": 12, "clock_offset_us": 8.4, "jitter_us": 1.4, "clock_state": "LOCKED"},
    {"id": "KRS-HIL", "name": "KRS HIL", "role": "통합시험/계측", "connected": False, "health": 0, "latency_ms": 0.0, "protocol": "DDS", "mode": "MOCK", "channels": 40, "clock_offset_us": None, "jitter_us": None, "clock_state": "UNSYNC"},
]

def hil_devices():
    return deepcopy(HIL_DEVICES)
