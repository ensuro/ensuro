from ethproto.wrappers import ETHWrapper, get_provider

PolicyPoolMock = ETHWrapper.build_from_def(get_provider().get_contract_def("PolicyPoolMock"))
PremiumsAccountMock = ETHWrapper.build_from_def(get_provider().get_contract_def("PolicyPoolComponentMock"))

PolicyPoolMockForward = ETHWrapper.build_from_def(get_provider().get_contract_def("PolicyPoolMockForward"))

ForwardProxy = ETHWrapper.build_from_def(get_provider().get_contract_def("ForwardProxy"))
