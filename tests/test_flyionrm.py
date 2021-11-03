"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from ethproto.contracts import RevertError, Contract, IntField, ERC20Token, ContractProxyField
from ethproto.wrappers import get_provider, IERC20, MethodAdapter
from prototype import ensuro
from ethproto.wadray import _W, _R, Wad
from prototype import wrappers
from prototype.utils import WEEK, DAY

TEnv = namedtuple("TEnv", "time_control currency pool pool_config kind module link_token")


class LinkTokenMock(IERC20):
    eth_contract = "LinkTokenMock"

    last_transfer_to = wrappers.MethodAdapter((), "address", is_property=True)
    last_transfer_value = wrappers.MethodAdapter((), "amount", is_property=True)
    last_transfer_data = wrappers.MethodAdapter((), "bytes", is_property=True)

    def __init__(self, owner="owner", name="Mock Link", symbol="mLINK", initial_supply=Wad(1000)):
        super().__init__(owner, name, symbol, initial_supply)


@pytest.fixture(params=["ethereum"])
def tenv(request):
    PolicyPoolMock = get_provider().get_contract_factory("PolicyPoolMock")

    currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
    config = wrappers.PolicyPoolConfig(owner="owner")
    link_token = LinkTokenMock()

    pool = PolicyPoolMock.deploy(currency.contract, config.contract, {"from": currency.owner})

    return TEnv(
        currency=currency,
        time_control=get_provider().time_control,
        pool_config=config,
        pool=wrappers.PolicyPool.connect(pool, currency.owner),
        link_token=link_token,
        kind="ethereum",
        module=wrappers,
    )


def test_flyion_set_oracle_params(tenv):
    FlyionRiskModule = tenv.module.FlyionRiskModule
    flyion = FlyionRiskModule(
        "Flyion", tenv.pool, link_token=tenv.link_token,
        oracle_params=FlyionRiskModule.OracleParams(
            oracle="ORACLE", delay_time=30, fee=_W("0.1"),
            data_job_id="0x2fb0c3a36f924e4ab43040291e14e0b7",
            sleep_job_id="0xb93734c968d741a4930571586f30d0e0"
        )
    )

    oracle_params = FlyionRiskModule.OracleParams(*flyion.oracle_params)
    assert oracle_params.oracle == "ORACLE"
    assert oracle_params.sleep_job_id == "0xb93734c968d741a4930571586f30d0e0"
    assert oracle_params.data_job_id == "0x2fb0c3a36f924e4ab43040291e14e0b7"
    assert oracle_params.delay_time == 30
    assert oracle_params.fee == _W("0.1")

    oracle_params = oracle_params._replace(delay_time=30, fee=_W("0.05"))

    with pytest.raises(RevertError, match="AccessControl"):
        flyion.oracle_params = oracle_params

    flyion.grant_role("ORACLE_ADMIN_ROLE", "SYSADMIN")

    with flyion.as_("SYSADMIN"):
        flyion.oracle_params = oracle_params

    assert oracle_params.oracle == "ORACLE"  # unchanged
    assert oracle_params.fee == _W("0.05")
    assert oracle_params.delay_time == 30
    assert oracle_params.sleep_job_id == "0xb93734c968d741a4930571586f30d0e0"
    assert oracle_params.data_job_id == "0x2fb0c3a36f924e4ab43040291e14e0b7"


def test_flyion_new_policy(tenv):
    FlyionRiskModule = tenv.module.FlyionRiskModule
    flyion = FlyionRiskModule(
        "Flyion", tenv.pool, link_token=tenv.link_token,
        oracle_params=FlyionRiskModule.OracleParams(
            oracle="ORACLE", delay_time=30, fee=_W("0.1"),
            data_job_id="0x2fb0c3a36f924e4ab43040291e14e0b7",
            sleep_job_id="0xb93734c968d741a4930571586f30d0e0"
        )
    )

    now = tenv.time_control.now

    new_policy_params = (
        "AR 1234", now + 3600, now + 3600 * 5, 1800,  # flight, departure, expectedArrival, tolerance
        _W(1000), _W(100), _R("0.1"), now + 3600 * 6, "CUST1",  # payout, premium, loss_prob, exp, cust
    )

    with pytest.raises(RevertError, match="AccessControl"):
        flyion.new_policy(*new_policy_params)

    flyion.grant_role("PRICER_ROLE", "BACKEND")
    tenv.currency.approve("CUST1", flyion.policy_pool, _W(100))

    with flyion.as_("BACKEND"):
        policy = flyion.new_policy(*new_policy_params)
    assert tenv.link_token.last_transfer_to == "ORACLE"
    assert tenv.link_token.last_transfer_value == _W("0.1")
    assert tenv.link_token.last_transfer_data
