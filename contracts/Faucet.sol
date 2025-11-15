// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract NativeFaucet {
    address public owner;

    uint256 public claimAmount;   // Amount of native coin (in wei)
    uint256 public cooldown;      // Seconds between claims
    bool public paused;           // Emergency switch

    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed user, uint256 amount);
    event Paused(bool status);
    event OwnerChanged(address indexed newOwner);
    event ClaimAmountUpdated(uint256 newAmount);
    event CooldownUpdated(uint256 newCooldown);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "Faucet paused");
        _;
    }

    constructor(
        uint256 _claimAmount,
        uint256 _cooldown
    ) payable {
        require(_claimAmount > 0, "Invalid amount");
        require(_cooldown > 0, "Invalid cooldown");

        owner = msg.sender;
        claimAmount = _claimAmount;
        cooldown = _cooldown;
    }

    // --- USER CLAIM (ON-CHAIN, requires sender signature) ---
    function claim() external notPaused {
        require(
            block.timestamp - lastClaim[msg.sender] >= cooldown,
            "Wait before next claim"
        );
        require(address(this).balance >= claimAmount, "Faucet empty");

        lastClaim[msg.sender] = block.timestamp;

        (bool sent, ) = msg.sender.call{value: claimAmount}("");
        require(sent, "Transfer failed");

        emit Claimed(msg.sender, claimAmount);
    }

    // --- ADMIN CLAIM FOR USER (server triggers this) ---
    function adminClaimFor(address recipient) external onlyOwner notPaused {
        require(recipient != address(0), "Invalid recipient");

        require(
            block.timestamp - lastClaim[recipient] >= cooldown,
            "Wait before next claim"
        );
        require(address(this).balance >= claimAmount, "Faucet empty");

        lastClaim[recipient] = block.timestamp;

        (bool sent, ) = recipient.call{value: claimAmount}("");
        require(sent, "Transfer failed");

        emit Claimed(recipient, claimAmount);
    }

    // --- OWNER FUNCTIONS ---
    function setClaimAmount(uint256 newAmount) external onlyOwner {
        require(newAmount > 0, "Invalid amount");
        claimAmount = newAmount;
        emit ClaimAmountUpdated(newAmount);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Invalid cooldown");
        cooldown = newCooldown;
        emit CooldownUpdated(newCooldown);
    }

    function setPaused(bool status) external onlyOwner {
        paused = status;
        emit Paused(status);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid");
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    // Withdraw leftover native coin
    function withdraw(uint256 amount) external onlyOwner {
        (bool sent, ) = owner.call{value: amount}("");
        require(sent, "Withdraw failed");
    }

    // Receive native coins
    receive() external payable {}
    fallback() external payable {}
}
