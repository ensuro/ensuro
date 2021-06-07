// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IEToken} from '../interfaces/IEToken.sol';

library DataTypes {
  using EnumerableSet for EnumerableSet.AddressSet;

  // Copied from OpenZeppelin's EnumerableMap but with address as keys
  // and reimplemented with interfaces as keys
  // To implement this library for multiple types with as little code
  // repetition as possible, we write it in terms of a generic Map type with
  // address keys and uint256 values.
  // The Map implementation uses private functions, and user-facing
  // implementations (such as Uint256ToAddressMap) are just wrappers around
  // the underlying Map.

  struct Map {
    // Storage of keys
    EnumerableSet.AddressSet _keys;

    mapping (address => uint256) _values;
  }

  /**
   * @dev Adds a key-value pair to a map, or updates the value for an existing
   * key. O(1).
   *
   * Returns true if the key was added to the map, that is if it was not
   * already present.
   */
  function _set(Map storage map, address key, uint256 value) private returns (bool) {
    map._values[key] = value;
    return map._keys.add(key);
  }

  /**
   * @dev Removes a key-value pair from a map. O(1).
   *
   * Returns true if the key was removed from the map, that is if it was present.
   */
  function _remove(Map storage map, address key) private returns (bool) {
    delete map._values[key];
    return map._keys.remove(key);
  }

  /**
   * @dev Returns true if the key is in the map. O(1).
   */
  function _contains(Map storage map, address key) private view returns (bool) {
    return map._keys.contains(key);
  }

  /**
   * @dev Returns the number of key-value pairs in the map. O(1).
   */
  function _length(Map storage map) private view returns (uint256) {
    return map._keys.length();
  }

  /**
  * @dev Returns the key-value pair stored at position `index` in the map. O(1).
  *
  * Note that there are no guarantees on the ordering of entries inside the
  * array, and it may change when more entries are added or removed.
  *
  * Requirements:
  *
  * - `index` must be strictly less than {length}.
  */
  function _at(Map storage map, uint256 index) private view returns (address, uint256) {
    address key = map._keys.at(index);
    return (key, map._values[key]);
  }

  /**
   * @dev Tries to returns the value associated with `key`.  O(1).
   * Does not revert if `key` is not in the map.
   */
  function _tryGet(Map storage map, address key) private view returns (bool, uint256) {
    uint256 value = map._values[key];
    if (value == 0) {
      return (_contains(map, key), 0);
    } else {
      return (true, value);
    }
  }

  /**
   * @dev Returns the value associated with `key`.  O(1).
   *
   * Requirements:
   *
   * - `key` must be in the map.
   */
  function _get(Map storage map, address key) private view returns (uint256) {
    uint256 value = map._values[key];
    require(value != 0 || _contains(map, key), "EnumerableMap: nonexistent key");
    return value;
  }

  /**
   * @dev Same as {_get}, with a custom error message when `key` is not in the map.
   *
   * CAUTION: This function is deprecated because it requires allocating memory for the error
   * message unnecessarily. For custom revert reasons use {_tryGet}.
   */
  function _get(Map storage map, address key, string memory errorMessage) private view returns (uint256) {
    uint256 value = map._values[key];
    require(value != 0 || _contains(map, key), errorMessage);
    return value;
  }

  // ETokenToWadMap
  struct ETokenToWadMap {
    Map _inner;
  }

  /**
   * @dev Adds a key-value pair to a map, or updates the value for an existing
   * key. O(1).
   *
   * Returns true if the key was added to the map, that is if it was not
   * already present.
   */
  function set(ETokenToWadMap storage map, IEToken key, uint256 value) internal returns (bool) {
    return _set(map._inner, address(key), value);
  }

  /**
   * @dev Removes a value from a set. O(1).
   *
   * Returns true if the key was removed from the map, that is if it was present.
   */
  function remove(ETokenToWadMap storage map, IEToken key) internal returns (bool) {
    return _remove(map._inner, address(key));
  }

  /**
   * @dev Returns true if the key is in the map. O(1).
   */
  function contains(ETokenToWadMap storage map, IEToken key) internal view returns (bool) {
    return _contains(map._inner, address(key));
  }

  /**
   * @dev Returns the number of elements in the map. O(1).
   */
  function length(ETokenToWadMap storage map) internal view returns (uint256) {
    return _length(map._inner);
  }

  /**
  * @dev Returns the element stored at position `index` in the set. O(1).
  * Note that there are no guarantees on the ordering of values inside the
  * array, and it may change when more values are added or removed.
  *
  * Requirements:
  *
  * - `index` must be strictly less than {length}.
  */
  function at(ETokenToWadMap storage map, uint256 index) internal view returns (IEToken, uint256) {
    (address key, uint256 value) = _at(map._inner, index);
    return (IEToken(key), uint256(value));
  }

  /**
   * @dev Tries to returns the value associated with `key`.  O(1).
   * Does not revert if `key` is not in the map.
   *
   * _Available since v3.4._
   */
  function tryGet(ETokenToWadMap storage map, IEToken key) internal view returns (bool, uint256) {
    (bool success, uint256 value) = _tryGet(map._inner, address(key));
    return (success, uint256(value));
  }

  /**
   * @dev Returns the value associated with `key`.  O(1).
   *
   * Requirements:
   *
   * - `key` must be in the map.
   */
  function get(ETokenToWadMap storage map, IEToken key) internal view returns (uint256) {
    return uint256(_get(map._inner, address(key)));
  }

  /**
   * @dev Same as {get}, with a custom error message when `key` is not in the map.
   *
   * CAUTION: This function is deprecated because it requires allocating memory for the error
   * message unnecessarily. For custom revert reasons use {tryGet}.
   */
  function get(ETokenToWadMap storage map, IEToken key, string memory errorMessage)
      internal view returns (uint256) {
    return uint256(_get(map._inner, address(key), errorMessage));
  }

}
