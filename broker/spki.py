import base64
import hashlib
import sys

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

with open(sys.argv[1], "rb") as certificate_file:
    certificate = x509.load_pem_x509_certificate(certificate_file.read())
public_key = certificate.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
print(base64.b64encode(hashlib.sha256(public_key).digest()).decode())
