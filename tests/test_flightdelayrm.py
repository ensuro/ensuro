"""Unitary tests for eToken contract"""

from collections import namedtuple
import pytest
from ethproto.contracts import RevertError
from ethproto.wrappers import get_provider, IERC20, MethodAdapter
from ethproto.wadray import _W, _R, Wad
from prototype import wrappers
from . import extract_vars


TEnv = namedtuple("TEnv", "time_control currency pool pool_config kind module link_token")


class LinkTokenMock(IERC20):
    eth_contract = "LinkTokenMock"

    last_transfer_to = MethodAdapter((), "address", is_property=True)
    last_transfer_value = MethodAdapter((), "amount", is_property=True)
    last_transfer_data = MethodAdapter((), "bytes", is_property=True)

    def __init__(self, owner="owner", name="Mock Link", symbol="mLINK", initial_supply=Wad(1000)):
        super().__init__(owner, name, symbol, initial_supply)


@pytest.fixture(params=["ethereum"])
def tenv(request):
    currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
    config = wrappers.PolicyPoolConfig(owner="owner")
    link_token = LinkTokenMock()

    pool = get_provider().deploy("PolicyPoolMock", (currency.contract, config.contract), currency.owner)

    return TEnv(
        currency=currency,
        time_control=get_provider().time_control,
        pool_config=config,
        pool=wrappers.PolicyPool.connect(pool, currency.owner),
        link_token=link_token,
        kind="ethereum",
        module=wrappers,
    )


def test_flightdelay_set_oracle_params(tenv):
    FlightDelayRiskModule = tenv.module.FlightDelayRiskModule
    rm = FlightDelayRiskModule(
        "Flyion", tenv.pool, link_token=tenv.link_token,
        oracle_params=FlightDelayRiskModule.OracleParams(
            oracle="ORACLE", delay_time=30, fee=_W("0.1"),
            data_job_id="0x2fb0c3a36f924e4ab43040291e14e0b7",
            sleep_job_id="0xb93734c968d741a4930571586f30d0e0"
        )
    )

    oracle_params = FlightDelayRiskModule.OracleParams(*rm.oracle_params)
    assert oracle_params.oracle == "ORACLE"
    assert oracle_params.sleep_job_id == "0xb93734c968d741a4930571586f30d0e0"
    assert oracle_params.data_job_id == "0x2fb0c3a36f924e4ab43040291e14e0b7"
    assert oracle_params.delay_time == 30
    assert oracle_params.fee == _W("0.1")

    oracle_params = oracle_params._replace(delay_time=30, fee=_W("0.05"))

    with pytest.raises(RevertError, match="AccessControl"):
        rm.oracle_params = oracle_params

    rm.grant_role("ORACLE_ADMIN_ROLE", "SYSADMIN")

    with rm.as_("SYSADMIN"):
        rm.oracle_params = oracle_params

    assert oracle_params.oracle == "ORACLE"  # unchanged
    assert oracle_params.fee == _W("0.05")
    assert oracle_params.delay_time == 30
    assert oracle_params.sleep_job_id == "0xb93734c968d741a4930571586f30d0e0"
    assert oracle_params.data_job_id == "0x2fb0c3a36f924e4ab43040291e14e0b7"


def test_flightdelay_setup_with_mock_oracle(tenv):
    FlightDelayRiskModule = tenv.module.FlightDelayRiskModule
    rm = FlightDelayRiskModule(
        "Flyion", tenv.pool, link_token=tenv.link_token,
        oracle_params=FlightDelayRiskModule.OracleParams(
            oracle="ORACLE", delay_time=30, fee=_W("0.1"),
            data_job_id="0x2fb0c3a36f924e4ab43040291e14e0b7",
            sleep_job_id="0xb93734c968d741a4930571586f30d0e0"
        )
    )

    # Build oracle mock
    provider = get_provider()
    mock_oracle = provider.deploy("ForwardProxy", (rm.contract.address,), rm.owner)

    # Change Oracle
    rm.grant_role("ORACLE_ADMIN_ROLE", rm.owner)
    rm.oracle_params = rm.OracleParams(*rm.oracle_params)._replace(oracle=mock_oracle.address)

    now = tenv.time_control.now

    rm.grant_role("PRICER_ROLE", "BACKEND")
    tenv.currency.approve("CUST1", rm.policy_pool, _W(100))

    thru_oracle_rm = provider.build_contract(
        mock_oracle.address, provider.get_contract_factory("FlightDelayRiskModule"), "FlightDelayRiskModule"
    )
    return locals()


def test_flightdelay_new_policy_resolved_payout0(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        123
    )

    with pytest.raises(RevertError, match="AccessControl"):
        rm.new_policy(*new_policy_params)

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert tenv.link_token.last_transfer_to == mock_oracle.address
    assert tenv.link_token.last_transfer_value == _W("0.1")
    assert tenv.link_token.last_transfer_data
    assert policy.id == rm.make_policy_id(123)

    assert "ChainlinkRequested" in rm.last_receipt.events
    query_id = rm.last_receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(
        query_id, expected_arrival + 300, {"from": rm.owner}
    )
    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id
    assert receipt.events["PolicyResolved"]["payout"] == 0
    assert receipt.events["PolicyResolved"]["policyId"] == rm.make_policy_id(123)


def test_flightdelay_new_policy_resolved_payout_full(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        111
    )

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert "ChainlinkRequested" in rm.last_receipt.events
    query_id = rm.last_receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(
        query_id, expected_arrival + 1800 + 10, {"from": rm.owner}
    )
    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id
    assert receipt.events["PolicyResolved"]["payout"] == _W(1000)
    assert receipt.events["PolicyResolved"]["policyId"] == policy.id


def test_flightdelay_new_policy_flight_cancelled(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        1122
    )

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert "ChainlinkRequested" in rm.last_receipt.events
    query_id = rm.last_receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(
        query_id, -1, {"from": rm.owner}
    )
    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id
    assert receipt.events["PolicyResolved"]["payout"] == _W(1000)
    assert receipt.events["PolicyResolved"]["policyId"] == policy.id


def test_flightdelay_zero_arrival_date(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        2323
    )

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert "ChainlinkRequested" in rm.last_receipt.events
    query_id = rm.last_receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(query_id, 0, {"from": rm.owner})

    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" not in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id

    # Jump after tolerance and resolvePolicy
    tenv.time_control.fast_forward(expected_arrival + 1800 + 200 - tenv.time_control.now)

    with pytest.raises(RevertError, match="AccessControl"):
        rm.resolve_policy(policy.id)

    with rm.as_("BACKEND"):
        receipt = rm.resolve_policy(policy.id)

    assert "ChainlinkRequested" in receipt.events
    query_id_2 = receipt.events["ChainlinkRequested"]["id"]
    # Check last_receipt has the same receipt
    assert "ChainlinkRequested" in rm.last_receipt.events
    assert rm.last_receipt.events["ChainlinkRequested"]["id"] == query_id_2

    # Sending zero again should now resolve the policy
    receipt_2 = thru_oracle_rm.fulfill(query_id_2, 0, {"from": rm.owner})

    assert "ChainlinkFulfilled" in receipt_2.events and "PolicyResolved" in receipt_2.events
    assert receipt_2.events["PolicyResolved"]["payout"] == _W(1000)
    assert receipt_2.events["PolicyResolved"]["policyId"] == policy.id


def test_flightdelay_resolve_manual_cancelled(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        333
    )

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert "ChainlinkRequested" in rm.last_receipt.events
    rm.last_receipt.events["ChainlinkRequested"]["id"]

    with pytest.raises(RevertError, match="AccessControl"):
        rm.resolve_policy(policy.id)

    with rm.as_("BACKEND"):
        receipt = rm.resolve_policy(policy.id)

    assert "ChainlinkRequested" in receipt.events
    query_id_2 = receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(query_id_2, -1, {"from": rm.owner})

    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id_2
    assert receipt.events["PolicyResolved"]["payout"] == _W(1000)
    assert receipt.events["PolicyResolved"]["policyId"] == policy.id


def test_flightdelay_resolve_manual_on_time(tenv):
    vars = test_flightdelay_setup_with_mock_oracle(tenv)
    rm, provider, now, mock_oracle, thru_oracle_rm = extract_vars(
        vars,
        "rm, provider, now, mock_oracle, thru_oracle_rm"
    )
    expected_arrival = now + 3600 * 5

    new_policy_params = (
        "AR 1234", now + 3600, expected_arrival, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), "CUST1",  # payout, premium, loss_prob, cust
        2121
    )

    with rm.as_("BACKEND"):
        policy = rm.new_policy(*new_policy_params)

    assert "ChainlinkRequested" in rm.last_receipt.events
    query_id = rm.last_receipt.events["ChainlinkRequested"]["id"]

    with pytest.raises(RevertError, match="AccessControl"):
        rm.resolve_policy(policy.id)

    with rm.as_("BACKEND"):
        receipt = rm.resolve_policy(policy.id)

    assert "ChainlinkRequested" in receipt.events
    query_id_2 = receipt.events["ChainlinkRequested"]["id"]

    receipt = thru_oracle_rm.fulfill(query_id_2, expected_arrival - 60, {"from": rm.owner})

    assert "ChainlinkFulfilled" in receipt.events and "PolicyResolved" in receipt.events
    assert receipt.events["ChainlinkFulfilled"]["id"] == query_id_2
    assert receipt.events["PolicyResolved"]["payout"] == _W(0)
    assert receipt.events["PolicyResolved"]["policyId"] == policy.id
