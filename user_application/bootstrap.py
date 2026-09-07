from digital_twin.runtime.state import RuntimeState
from digital_twin.model_library.devices import hil_devices
from user_application.configs.missions import missions
from user_application.configs.scenarios import scenarios


def create_runtime() -> RuntimeState:
    return RuntimeState(missions=missions(), devices=hil_devices(), scenarios=scenarios())
