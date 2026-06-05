// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * CareFund - Campaign-enabled smart contract compatible with the frontend.
 * - Supports multiple campaigns
 * - Tracks per-donor history
 * - Emits indexed events so frontend can filter by campaignId
 */
contract CareFund {
    struct Campaign {
        address creator;
        string title;
        string description;
        uint256 goalAmount;
        uint256 raisedAmount;
        uint256 deadline;
        string category;
        bool active;
        uint256 donorCount;
    }

    Campaign[] public campaigns;

    // Donation history per donor
    mapping(address => uint256[]) private donorCampaignIds;
    mapping(address => uint256[]) private donorAmounts;
    mapping(address => uint256[]) private donorTimestamps;

    // Campaigns created by a creator
    mapping(address => uint256[]) private campaignsByCreator;

    // Events
    event CampaignCreated(uint256 indexed campaignId, address indexed creator);
    event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount);
    event FundsWithdrawn(uint256 indexed campaignId, address indexed owner, uint256 amount);

    /** Create a new campaign */
    function createCampaign(
        string calldata title,
        string calldata description,
        uint256 goalAmount,
        uint256 durationDays,
        string calldata category
    ) external returns (uint256) {
        require(goalAmount > 0, "Goal must be > 0");
        require(durationDays > 0, "Duration must be > 0");

        uint256 deadline = block.timestamp + (durationDays * 1 days);
        campaigns.push(Campaign({
            creator: msg.sender,
            title: title,
            description: description,
            goalAmount: goalAmount,
            raisedAmount: 0,
            deadline: deadline,
            category: category,
            active: true,
            donorCount: 0
        }));

        uint256 id = campaigns.length - 1;
        campaignsByCreator[msg.sender].push(id);
        emit CampaignCreated(id, msg.sender);
        return id;
    }

    /** Donate to a campaign */
    function donate(uint256 campaignId) external payable {
        require(campaignId < campaigns.length, "Campaign not found");
        require(msg.value > 0, "Donation must be > 0");

        Campaign storage c = campaigns[campaignId];
        require(c.active, "Campaign not active");
        require(block.timestamp <= c.deadline, "Campaign ended");

        c.raisedAmount += msg.value;
        c.donorCount += 1;

        donorCampaignIds[msg.sender].push(campaignId);
        donorAmounts[msg.sender].push(msg.value);
        donorTimestamps[msg.sender].push(block.timestamp);

        emit DonationReceived(campaignId, msg.sender, msg.value);
    }

    /** Returns number of campaigns */
    function getCampaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    /** Get campaign details */
    function getCampaign(uint256 campaignId)
        external
        view
        returns (
            address creator,
            string memory title,
            string memory description,
            uint256 goalAmount,
            uint256 raisedAmount,
            uint256 deadline,
            string memory category,
            bool active,
            uint256 donorCount
        )
    {
        require(campaignId < campaigns.length, "Campaign not found");
        Campaign storage c = campaigns[campaignId];
        return (
            c.creator,
            c.title,
            c.description,
            c.goalAmount,
            c.raisedAmount,
            c.deadline,
            c.category,
            c.active,
            c.donorCount
        );
    }

    /** Get donation history for an address */
    function getDonationHistory(address donor)
        external
        view
        returns (uint256[] memory campaignIds, uint256[] memory amounts, uint256[] memory timestamps)
    {
        return (donorCampaignIds[donor], donorAmounts[donor], donorTimestamps[donor]);
    }

    /** Get campaigns created by an address */
    function getCampaignsByCreator(address creator) external view returns (uint256[] memory) {
        return campaignsByCreator[creator];
    }

    /** Withdraw raised funds for a campaign (only creator) */
    function withdrawCampaign(uint256 campaignId) external {
        require(campaignId < campaigns.length, "Campaign not found");
        Campaign storage c = campaigns[campaignId];
        require(msg.sender == c.creator, "Only creator can withdraw");
        uint256 balance = c.raisedAmount;
        require(balance > 0, "No funds to withdraw");

        // zero before transfer to prevent reentrancy
        c.raisedAmount = 0;
        c.active = false;

        (bool success, ) = payable(msg.sender).call{value: balance}("");
        require(success, "Withdraw failed");

        emit FundsWithdrawn(campaignId, msg.sender, balance);
    }
}