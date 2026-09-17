// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockGCC is ERC20 {
    constructor() ERC20("Mock Gold Condor Capital", "mGCC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
