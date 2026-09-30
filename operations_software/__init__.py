"""Stand-in implementations of the operations software that partner organisations will deliver.

Nothing here imports the digital twin. The twin reaches these modules only through the ICD
messages served by communication/http, so a real module can replace a stand-in without a code
change on the twin side.
"""
